/**
 * Custom SSE client for Urbit that works in Node.js
 * Handles authentication cookies and streaming properly
 */

import { Readable } from "stream";

export class UrbitSSEClient {
  constructor(url, cookie, options = {}) {
    this.url = url;
    // Extract just the cookie value (first part before semicolon)
    this.cookie = cookie.split(";")[0];
    this.channelId = `${Math.floor(Date.now() / 1000)}-${Math.random()
      .toString(36)
      .substring(2, 8)}`;
    this.channelUrl = `${url}/~/channel/${this.channelId}`;
    this.subscriptions = [];
    this.eventHandlers = new Map();
    this.aborted = false;
    this.streamController = null;

    // Reconnection settings
    this.onReconnect = options.onReconnect || null;
    this.autoReconnect = options.autoReconnect !== false; // Default true
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.reconnectDelay = options.reconnectDelay || 1000; // Start at 1s
    this.maxReconnectDelay = options.maxReconnectDelay || 30000; // Max 30s
    this.isConnected = false;
  }

  /**
   * Subscribe to an Urbit path
   */
  async subscribe({ app, path, event, err, quit }) {
    const subId = this.subscriptions.length + 1;

    this.subscriptions.push({
      id: subId,
      action: "subscribe",
      ship: this.url.match(/\/\/([^.]+)/)[1].replace("~", ""),
      app,
      path,
    });

    // Store event handlers
    this.eventHandlers.set(subId, { event, err, quit });

    return subId;
  }

  /**
   * Create the channel and start listening for events
   */
  async connect() {
    // Create channel with all subscriptions
    const createResp = await fetch(this.channelUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookie,
      },
      body: JSON.stringify(this.subscriptions),
    });

    if (!createResp.ok && createResp.status !== 204) {
      throw new Error(`Channel creation failed: ${createResp.status}`);
    }

    // Send helm-hi poke to activate the channel
    // This is required before opening the SSE stream
    const pokeResp = await fetch(this.channelUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookie,
      },
      body: JSON.stringify([
        {
          id: Date.now(),
          action: "poke",
          ship: this.url.match(/\/\/([^.]+)/)[1].replace("~", ""),
          app: "hood",
          mark: "helm-hi",
          json: "Opening API channel",
        },
      ]),
    });

    if (!pokeResp.ok && pokeResp.status !== 204) {
      throw new Error(`Channel activation failed: ${pokeResp.status}`);
    }

    // Open SSE stream
    await this.openStream();
    this.isConnected = true;
    this.reconnectAttempts = 0; // Reset on successful connection
  }

  /**
   * Open the SSE stream and process events
   */
  async openStream() {
    const response = await fetch(this.channelUrl, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Cookie: this.cookie,
      },
    });

    if (!response.ok) {
      throw new Error(`Stream connection failed: ${response.status}`);
    }

    // Start processing the stream in the background (don't await)
    this.processStream(response.body).catch((error) => {
      if (!this.aborted) {
        console.error("Stream error:", error);
        // Notify all error handlers
        for (const { err } of this.eventHandlers.values()) {
          if (err) err(error);
        }
      }
    });

    // Stream is connected and running in background
    // Return immediately so connect() can complete
  }

  /**
   * Process the SSE stream (runs in background)
   */
  async processStream(body) {
    const reader = body;
    let buffer = "";

    // Convert Web ReadableStream to Node Readable if needed
    const stream =
      reader instanceof ReadableStream ? Readable.fromWeb(reader) : reader;

    try {
      for await (const chunk of stream) {
        if (this.aborted) break;

        buffer += chunk.toString();

        // Process complete SSE events
        let eventEnd;
        while ((eventEnd = buffer.indexOf("\n\n")) !== -1) {
          const eventData = buffer.substring(0, eventEnd);
          buffer = buffer.substring(eventEnd + 2);

          this.processEvent(eventData);
        }
      }
    } finally {
      // Stream ended (either normally or due to error)
      if (!this.aborted && this.autoReconnect) {
        this.isConnected = false;
        console.log("[SSE] Stream ended, attempting reconnection...");
        await this.attemptReconnect();
      }
    }
  }

  /**
   * Process a single SSE event
   */
  processEvent(eventData) {
    const lines = eventData.split("\n");
    let id = null;
    let data = null;

    for (const line of lines) {
      if (line.startsWith("id: ")) {
        id = line.substring(4);
      } else if (line.startsWith("data: ")) {
        data = line.substring(6);
      }
    }

    if (!data) return;

    try {
      const parsed = JSON.parse(data);

      // Handle quit events - subscription ended
      if (parsed.response === "quit") {
        console.log(`[SSE] Received quit event for subscription ${parsed.id}`);
        const handlers = this.eventHandlers.get(parsed.id);
        if (handlers && handlers.quit) {
          handlers.quit();
        }
        return;
      }

      // Debug: Log received events (skip subscription confirmations)
      if (parsed.response !== "subscribe" && parsed.response !== "poke") {
        console.log("[SSE] Received event:", JSON.stringify(parsed).substring(0, 500));
      }

      // Route to appropriate handler based on subscription
      if (parsed.id && this.eventHandlers.has(parsed.id)) {
        const { event } = this.eventHandlers.get(parsed.id);
        if (event && parsed.json) {
          console.log(`[SSE] Calling handler for subscription ${parsed.id}`);
          event(parsed.json);
        }
      } else if (parsed.json) {
        // Try to match by response structure for events without specific ID
        console.log(`[SSE] Broadcasting event to all handlers`);
        for (const { event } of this.eventHandlers.values()) {
          if (event) {
            event(parsed.json);
          }
        }
      }
    } catch (error) {
      console.error("Error parsing SSE event:", error);
    }
  }

  /**
   * Send a poke to Urbit
   */
  async poke({ app, mark, json }) {
    const pokeId = Date.now();

    const pokeData = {
      id: pokeId,
      action: "poke",
      ship: this.url.match(/\/\/([^.]+)/)[1].replace("~", ""),
      app,
      mark,
      json,
    };

    console.log(`[SSE] Sending poke to ${app}:`, JSON.stringify(pokeData).substring(0, 300));

    const response = await fetch(this.channelUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookie,
      },
      body: JSON.stringify([pokeData]),
    });

    console.log(`[SSE] Poke response status: ${response.status}`);

    if (!response.ok && response.status !== 204) {
      const errorText = await response.text();
      console.log(`[SSE] Poke error body: ${errorText.substring(0, 500)}`);
      throw new Error(`Poke failed: ${response.status} - ${errorText}`);
    }

    return pokeId;
  }

  /**
   * Perform a scry (read-only query) to Urbit
   */
  async scry(path) {
    const scryUrl = `${this.url}/~/scry${path}`;

    const response = await fetch(scryUrl, {
      method: "GET",
      headers: {
        Cookie: this.cookie,
      },
    });

    if (!response.ok) {
      throw new Error(`Scry failed: ${response.status} for path ${path}`);
    }

    return await response.json();
  }

  /**
   * Attempt to reconnect with exponential backoff
   */
  async attemptReconnect() {
    if (this.aborted || !this.autoReconnect) {
      console.log("[SSE] Reconnection aborted or disabled");
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(
        `[SSE] Max reconnection attempts (${this.maxReconnectAttempts}) reached. Giving up.`
      );
      return;
    }

    this.reconnectAttempts++;

    // Calculate delay with exponential backoff
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );

    console.log(
      `[SSE] Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`
    );

    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      // Generate new channel ID for reconnection
      this.channelId = `${Math.floor(Date.now() / 1000)}-${Math.random()
        .toString(36)
        .substring(2, 8)}`;
      this.channelUrl = `${this.url}/~/channel/${this.channelId}`;

      console.log(`[SSE] Reconnecting with new channel ID: ${this.channelId}`);

      // Call reconnect callback if provided
      if (this.onReconnect) {
        await this.onReconnect(this);
      }

      // Reconnect
      await this.connect();

      console.log("[SSE] Reconnection successful!");
    } catch (error) {
      console.error(`[SSE] Reconnection failed: ${error.message}`);
      // Try again
      await this.attemptReconnect();
    }
  }

  /**
   * Close the connection
   */
  async close() {
    this.aborted = true;
    this.isConnected = false;

    try {
      // Send unsubscribe for all subscriptions
      const unsubscribes = this.subscriptions.map((sub) => ({
        id: sub.id,
        action: "unsubscribe",
        subscription: sub.id,
      }));

      await fetch(this.channelUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Cookie: this.cookie,
        },
        body: JSON.stringify(unsubscribes),
      });

      // Delete the channel
      await fetch(this.channelUrl, {
        method: "DELETE",
        headers: {
          Cookie: this.cookie,
        },
      });
    } catch (error) {
      console.error("Error closing channel:", error);
    }
  }
}
