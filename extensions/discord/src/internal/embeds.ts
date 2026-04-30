import type { APIEmbed } from "discord-api-types/v10";

function clean<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export class Embed {
  title?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  footer?: APIEmbed["footer"];
  image?: string | APIEmbed["image"];
  thumbnail?: string | APIEmbed["thumbnail"];
  author?: APIEmbed["author"];
  fields?: APIEmbed["fields"];
  constructor(embed?: APIEmbed) {
    Object.assign(this, embed);
  }
  serialize(): APIEmbed {
    return clean({
      title: this.title,
      description: this.description,
      url: this.url,
      timestamp: this.timestamp,
      color: this.color,
      footer: this.footer,
      image: typeof this.image === "string" ? { url: this.image } : this.image,
      thumbnail: typeof this.thumbnail === "string" ? { url: this.thumbnail } : this.thumbnail,
      author: this.author,
      fields: this.fields,
    }) as APIEmbed;
  }
}
