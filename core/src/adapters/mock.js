/**
 * Adapter de desenvolvimento. Não fala com o Discord — guarda tudo em memória e
 * imprime no terminal, para que o loop completo rode sem token.
 */
export class MockAdapter {
  constructor({ guilds = [], verbose = true } = {}) {
    this.kind = "mock";
    this.guilds = guilds;
    this.verbose = verbose;
    this.messages = [];
    this.edits = [];
    this.roles = [];
    this.kicks = [];
    this.seq = 0;
  }

  async start() {}

  roleId(name) {
    return String(4000 + (name.length % 50));
  }

  async sendMessage({ guildId, channelId, content, ephemeral, pluginId }) {
    const id = `msg-${++this.seq}`;
    const rec = { id, guildId, channelId, content, ephemeral: !!ephemeral, pluginId, ts: Date.now() };
    this.messages.push(rec);
    if (this.verbose) {
      const tag = ephemeral ? " (só você)" : "";
      process.stdout.write(`  \x1b[2m[${pluginId}]\x1b[0m ${content}${tag}\n`);
    }
    return rec;
  }

  async editMessage({ channelId, messageId, content }) {
    this.edits.push({ channelId, messageId, content, ts: Date.now() });
    return { messageId, content };
  }

  async addRole({ guildId, userId, roleId }) {
    this.roles.push({ guildId, userId, roleId, op: "add" });
    return { ok: true };
  }

  async removeRole({ guildId, userId, roleId }) {
    this.roles.push({ guildId, userId, roleId, op: "remove" });
    return { ok: true };
  }

  async kick({ guildId, userId, reason }) {
    this.kicks.push({ guildId, userId, reason });
    return { ok: true };
  }

  lastMessage(pluginId) {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (!pluginId || this.messages[i].pluginId === pluginId) return this.messages[i];
    }
    return null;
  }
}
