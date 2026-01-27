#!/usr/bin/env bun
/**
 * LemonSqueezy CLI - Revenue, orders, subscriptions at your fingertips
 * Usage: bun skills/lemonsqueezy/cli.ts <command> [options]
 */

const API_KEY = process.env.LEMONSQUEEZY_API_KEY;
const BASE_URL = "https://api.lemonsqueezy.com/v1";

if (!API_KEY) {
  console.error("Error: LEMONSQUEEZY_API_KEY environment variable required");
  console.error("Set it in your shell or source from SECRETS.env");
  process.exit(1);
}

async function api(endpoint: string, params: Record<string, string> = {}) {
  const url = new URL(`${BASE_URL}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v) url.searchParams.append(k, v);
  });

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/vnd.api+json",
    },
  });

  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function cents(n: number): string {
  return `$${(n / 100).toFixed(2)}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// Commands
async function overview() {
  const { data } = await api("/stores");
  const store = data[0]?.attributes;
  if (!store) {
    console.log("No stores found");
    return;
  }

  console.log(`📊 ${store.name} Revenue Overview\n`);
  console.log(`Total Revenue:    ${cents(store.total_revenue)}`);
  console.log(`Total Sales:      ${store.total_sales}`);
  console.log(`30-Day Revenue:   ${cents(store.thirty_day_revenue)}`);
  console.log(`30-Day Sales:     ${store.thirty_day_sales}`);
}

async function orders(limit = 20, status?: string, from?: string, to?: string) {
  const params: Record<string, string> = { "page[size]": String(limit) };
  if (status) params["filter[status]"] = status;

  const { data } = await api("/orders", params);

  // Filter by date if provided
  let filtered = data;
  if (from || to) {
    const fromDate = from ? new Date(from) : new Date(0);
    const toDate = to ? new Date(to) : new Date();
    toDate.setHours(23, 59, 59, 999); // End of day
    filtered = data.filter((order: any) => {
      const created = new Date(order.attributes.created_at);
      return created >= fromDate && created <= toDate;
    });
  }

  const dateRange = from || to ? ` (${from || "start"} to ${to || "now"})` : "";
  console.log(`📦 Orders${dateRange} (${filtered.length})\n`);

  // Group by week for summary if date range specified
  if (from && to) {
    const byWeek: Record<string, { count: number; revenue: number }> = {};
    for (const order of filtered) {
      const a = order.attributes;
      const date = new Date(a.created_at);
      const week = getWeekNumber(date);
      const key = `${date.getFullYear()}-W${week.toString().padStart(2, "0")}`;
      if (!byWeek[key]) byWeek[key] = { count: 0, revenue: 0 };
      byWeek[key].count++;
      byWeek[key].revenue += parseInt(a.total_usd || 0) / 100;
    }

    console.log("Week".padEnd(10) + "Orders".padStart(8) + "Revenue".padStart(12));
    console.log("-".repeat(30));
    const weeks = Object.entries(byWeek).sort(([a], [b]) => a.localeCompare(b));
    for (const [week, stats] of weeks) {
      console.log(
        week.padEnd(10) +
          stats.count.toString().padStart(8) +
          `$${stats.revenue.toFixed(2)}`.padStart(12)
      );
    }
    console.log();
  }

  // Individual orders
  for (const order of filtered) {
    const a = order.attributes;
    const statusIcon = a.status === "paid" ? "✓" : a.status === "refunded" ? "↩" : "○";
    console.log(
      `${statusIcon} #${a.order_number} | ${a.total_formatted.padEnd(10)} | ${a.user_email} | ${formatDate(a.created_at)}`
    );
  }
}

function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

async function orderLookup(query: string) {
  // Try by order number first, then by email
  let orders: any[] = [];

  if (query.includes("@")) {
    const { data } = await api("/orders", { "filter[user_email]": query });
    orders = data;
  } else {
    const { data } = await api("/orders");
    orders = data.filter(
      (o: any) => o.attributes.order_number.toString() === query
    );
  }

  if (orders.length === 0) {
    console.log(`No orders found for: ${query}`);
    return;
  }

  console.log(`🔍 Orders for ${query}\n`);
  for (const order of orders) {
    const a = order.attributes;
    console.log(`Order #${a.order_number}`);
    console.log(`  Status:   ${a.status}${a.refunded ? " (refunded)" : ""}`);
    console.log(`  Total:    ${a.total_formatted}`);
    console.log(`  Customer: ${a.user_name} <${a.user_email}>`);
    console.log(`  Date:     ${formatDate(a.created_at)}`);
    if (a.refunded_at) console.log(`  Refunded: ${formatDate(a.refunded_at)}`);
    console.log();
  }
}

async function subscriptions(status?: string) {
  const params: Record<string, string> = { "page[size]": "100" };
  if (status) params["filter[status]"] = status;

  const { data } = await api("/subscriptions", params);

  // Calculate MRR
  let mrr = 0;
  const byStatus: Record<string, number> = {};

  for (const sub of data) {
    const s = sub.attributes;
    byStatus[s.status] = (byStatus[s.status] || 0) + 1;
    if (s.status === "active") {
      // Assuming monthly - would need price endpoint for accuracy
      mrr += parseInt(s.first_subscription_item?.price || 0) / 100;
    }
  }

  console.log(`💳 Subscriptions (${data.length})\n`);
  console.log("By Status:");
  for (const [st, count] of Object.entries(byStatus)) {
    console.log(`  ${st}: ${count}`);
  }
  console.log(`\nEstimated MRR: $${mrr.toFixed(2)}\n`);

  if (data.length > 0) {
    console.log("Recent:");
    for (const sub of data.slice(0, 10)) {
      const s = sub.attributes;
      const icon =
        s.status === "active" ? "●" : s.status === "cancelled" ? "○" : "◐";
      console.log(
        `  ${icon} ${s.user_email.padEnd(30)} | ${s.status.padEnd(10)} | ${s.product_name}`
      );
    }
  }
}

async function mrr() {
  const { data } = await api("/subscriptions", {
    "filter[status]": "active",
    "page[size]": "100",
  });

  const byProduct: Record<string, { count: number; mrr: number }> = {};

  for (const sub of data) {
    const s = sub.attributes;
    const key = `${s.product_name} - ${s.variant_name}`;
    if (!byProduct[key]) byProduct[key] = { count: 0, mrr: 0 };
    byProduct[key].count++;
    // Price from first_subscription_item
    const price = parseInt(s.first_subscription_item?.price || 0) / 100;
    byProduct[key].mrr += price;
  }

  const sorted = Object.entries(byProduct).sort(
    ([, a], [, b]) => b.mrr - a.mrr
  );
  const totalMRR = sorted.reduce((sum, [, v]) => sum + v.mrr, 0);

  console.log(`💰 MRR Breakdown\n`);
  console.log(`Total MRR: $${totalMRR.toFixed(2)}`);
  console.log(`Active Subscribers: ${data.length}\n`);

  for (const [product, stats] of sorted) {
    console.log(`${product}`);
    console.log(`  Subscribers: ${stats.count}`);
    console.log(`  MRR: $${stats.mrr.toFixed(2)}`);
  }
}

async function customers(limit = 20) {
  const { data } = await api("/customers", { "page[size]": String(limit) });

  let totalLTV = 0;
  console.log(`👥 Customers (${data.length})\n`);

  for (const cust of data) {
    const c = cust.attributes;
    const ltv = parseInt(c.total_revenue_currency || 0) / 100;
    totalLTV += ltv;
    console.log(
      `${c.email.padEnd(35)} | LTV: $${ltv.toFixed(2).padStart(8)} | ${c.status}`
    );
  }

  console.log(`\nTotal LTV: $${totalLTV.toFixed(2)}`);
}

async function products() {
  const { data } = await api("/products");

  console.log(`📦 Products (${data.length})\n`);
  for (const prod of data) {
    const p = prod.attributes;
    const statusIcon = p.status === "published" ? "●" : "○";
    console.log(`${statusIcon} ${p.name}`);
    console.log(`  Price: ${p.price_formatted || "varies"}`);
    console.log(`  URL: ${p.buy_now_url}`);
    console.log();
  }
}

async function refunds(limit = 20) {
  // Fetch all orders and filter for refunded ones client-side
  // (LemonSqueezy API filter[refunded] is unreliable)
  const { data } = await api("/orders", {
    "page[size]": String(Math.min(limit * 5, 100)), // Fetch more to find refunds
  });

  const refunded = data.filter((o: any) =>
    o.attributes.refunded || o.attributes.status === "refunded"
  ).slice(0, limit);

  const total = refunded.reduce(
    (sum: number, o: any) => sum + parseInt(o.attributes.total_usd || 0),
    0
  );

  console.log(`↩️ Refunds (${refunded.length})\n`);
  console.log(`Total Refunded: ${cents(total)}\n`);

  if (refunded.length === 0) {
    console.log("No refunds found.");
    return;
  }

  for (const order of refunded) {
    const a = order.attributes;
    console.log(
      `#${a.order_number} | ${a.total_formatted.padEnd(10)} | ${a.user_email} | ${formatDate(a.refunded_at || a.created_at)}`
    );
  }
}

// Help
function help() {
  console.log(`
LemonSqueezy CLI

Usage: ls <command> [options]

Commands:
  overview              Revenue overview (total + 30-day)
  orders [--limit N]    Recent orders (default: 20)
  orders --status X     Filter by status (paid/refunded/pending)
  orders --from DATE --to DATE
                        Orders in date range with week-by-week summary
  order <num|email>     Lookup by order number or customer email
  subs [--status X]     Subscriptions list
  mrr                   MRR breakdown by product
  customers [--limit N] Customer list with LTV
  products              All products
  refunds [--limit N]   Refunded orders

Environment:
  LEMONSQUEEZY_API_KEY  API key (required)

Examples:
  ls overview
  ls orders --limit 10
  ls orders --from 2025-11-01 --to 2026-01-20
  ls order 12345
  ls order customer@example.com
  ls subs --status active
  ls mrr
`);
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  // Parse flags
  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      flags[key] = args[i + 1] || "true";
      i++;
    }
  }

  try {
    switch (cmd) {
      case "overview":
        await overview();
        break;
      case "orders":
        await orders(parseInt(flags.limit) || 100, flags.status, flags.from, flags.to);
        break;
      case "order":
        const query = args[1];
        if (!query) {
          console.error("Usage: ls order <order_number|email>");
          process.exit(1);
        }
        await orderLookup(query);
        break;
      case "subs":
      case "subscriptions":
        await subscriptions(flags.status);
        break;
      case "mrr":
        await mrr();
        break;
      case "customers":
        await customers(parseInt(flags.limit) || 20);
        break;
      case "products":
        await products();
        break;
      case "refunds":
        await refunds(parseInt(flags.limit) || 20);
        break;
      case "help":
      case "--help":
      case "-h":
      case undefined:
        help();
        break;
      default:
        console.error(`Unknown command: ${cmd}`);
        help();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

main();
