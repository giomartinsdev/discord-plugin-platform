/**
 * Adapter real. discord.js é dependência opcional: instale com
 *   npm i discord.js
 * e rode com DISCORD_TOKEN + DISCORD_APP_ID no ambiente.
 */
export class DiscordAdapter {
  constructor({ token, appId, verbose = false }) {
    this.kind = "discord";
    this.token = token;
    this.appId = appId;
    this.verbose = verbose;
    this.client = null;
    this.cmdIndex = new Map();
  }

  async start() {
    let discord;
    try {
      discord = await import("discord.js");
    } catch {
      const err = new Error(
        "discord.js não está instalado. Rode `npm i discord.js` ou use o adapter mock (ADAPTER=mock).",
      );
      err.code = "E_NO_DISCORD_JS";
      throw err;
    }

    const { Client, GatewayIntentBits, Events, REST, Routes } = discord;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
      ],
    });

    this.client.once(Events.ClientReady, (c) => {
      console.log(`bot conectado como ${c.user.tag}`);
    });

    this.client.on(Events.MessageCreate, (msg) => {
      if (msg.author.bot) return;
      const m = /^!(\S+)(?:\s+([\s\S]*))?$/.exec(msg.content);
      if (!m) return;
      this.emit("message", {
        command: m[1].toLowerCase(),
        args: (m[2] ?? "").split(/\s+/).filter(Boolean),
        guildId: msg.guildId,
        channelId: msg.channelId,
        userId: msg.author.id,
        messageId: msg.id,
        isInteraction: false,
        replyTarget: msg,
      });
    });

    this.client.on(Events.InteractionCreate, async (i) => {
      if (!i.isChatInputCommand()) return;
      this.emit("command", {
        command: i.commandName,
        args: i.options.data.map((o) => String(o.value)),
        guildId: i.guildId,
        channelId: i.channelId,
        userId: i.user.id,
        messageId: i.id,
        isInteraction: true,
        interaction: i,
      });
    });

    this.client.on(Events.GuildMemberAdd, (m) => {
      this.emit("event", {
        type: "GUILD_MEMBER_ADD",
        guildId: m.guild.id,
        payload: { userId: m.id, username: m.user.username },
      });
    });

    await this.client.login(this.token);
    this.discord = discord;
  }

  emit(kind, data) {
    if (this.onEmit) this.onEmit(kind, data);
  }

  /** registra slash commands no Discord */
  async registerCommands(commands) {
    if (!this.token || !this.appId) return { skipped: true };
    const { REST, Routes } = this.discord;
    const rest = new REST({ version: "10" }).setToken(this.token);
    const body = commands.map((c) => ({ name: c.name, description: c.description || c.name }));
    await rest.put(Routes.applicationCommands(this.appId), { body });
    return { count: body.length };
  }

  async sendMessage({ guildId, channelId, content, ephemeral, interactionId }) {
    if (interactionId) {
      const i = this.pendingInteractions?.get(interactionId);
      if (i) return i.reply({ content, ephemeral });
    }
    const ch = await this.client.channels.fetch(channelId);
    return ch.send(content);
  }

  async editMessage({ channelId, messageId, content }) {
    const ch = await this.client.channels.fetch(channelId);
    const msg = await ch.messages.fetch(messageId);
    return msg.edit(content);
  }

  async addRole({ guildId, userId, roleId }) {
    const g = await this.client.guilds.fetch(guildId);
    const m = await g.members.fetch(userId);
    return m.roles.add(roleId);
  }

  async removeRole({ guildId, userId, roleId }) {
    const g = await this.client.guilds.fetch(guildId);
    const m = await g.members.fetch(userId);
    return m.roles.remove(roleId);
  }

  async kick({ guildId, userId, reason }) {
    const g = await this.client.guilds.fetch(guildId);
    const m = await g.members.fetch(userId);
    return m.kick(reason);
  }

  async stop() {
    try { await this.client?.destroy(); } catch {}
  }
}
