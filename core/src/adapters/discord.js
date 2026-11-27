/**
 * Adapter real. discord.js é dependência opcional: instale com
 *   npm i discord.js
 * e rode com DISCORD_TOKEN + DISCORD_APP_ID no ambiente (ou no .env).
 */
export class DiscordAdapter {
  constructor({ token, appId, verbose = false } = {}) {
    this.kind = "discord";
    this.token = token;
    this.appId = appId;
    this.verbose = verbose;
    this.client = null;
    this.cmdIndex = new Map();
    /** messageId → interação pendente, para que `reply` vire uma resposta de verdade */
    this.interactions = new Map();
    this.guildsCache = [];
  }

  async start() {
    if (!this.token) {
      const err = new Error("DISCORD_TOKEN ausente. Defina no ambiente ou no .env.");
      err.code = "E_NO_TOKEN";
      throw err;
    }
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

    const { Client, GatewayIntentBits, Events } = discord;
    this.discord = discord;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
      ],
    });

    this.client.on(Events.MessageCreate, (msg) => {
      if (msg.author.bot) return;
      if (!msg.guildId) return;
      const m = /^!(\S+)(?:\s+([\s\S]*))?$/.exec(msg.content);
      if (!m) return;
      this.emit("command", {
        command: m[1].toLowerCase(),
        args: (m[2] ?? "").split(/\s+/).filter(Boolean),
        guildId: msg.guildId,
        channelId: msg.channelId,
        userId: msg.author.id,
        messageId: msg.id,
        isInteraction: false,
      });
    });

    this.client.on(Events.InteractionCreate, (i) => {
      if (!i.isChatInputCommand()) return;
      if (!i.guildId) return;
      this.interactions.set(i.id, i);
      this.interactionTimers = this.interactionTimers ?? new Map();
      this.answered = this.answered ?? new Set();

      // o Discord exige uma resposta em 3 s. Plugins podem levar até 8 s (Go, Java),
      // então se o plugin demorar, adiamos — isso compra 15 min para a resposta real.
      const timer = setTimeout(() => {
        if (this.answered.has(i.id) || i.replied || i.deferred) return;
        i.deferReply().catch(() => {});
      }, 2000);
      timer.unref?.();
      this.interactionTimers.set(i.id, timer);

      setTimeout(() => this.interactions.delete(i.id), 15 * 60 * 1000).unref?.();

      // o campo livre "argumentos" carrega o texto inteiro: separa como no `!comando`
      const args = i.options.data.flatMap((o) => {
        if (o.value === undefined || o.value === null) return [];
        const s = String(o.value);
        return o.name === "argumentos" ? s.split(/\s+/).filter(Boolean) : [s];
      });

      this.emit("command", {
        command: i.commandName,
        args,
        guildId: i.guildId,
        channelId: i.channelId,
        userId: i.user.id,
        messageId: i.id,
        isInteraction: true,
      });
    });

    this.client.on(Events.GuildMemberAdd, (m) => {
      this.emit("event", {
        type: "GUILD_MEMBER_ADD",
        guildId: m.guild.id,
        payload: { userId: m.id, username: m.user.username },
      });
    });

    this.client.on(Events.Error, (err) => {
      process.stderr.write(`[discord] ${err.message}\n`);
    });

    // login resolve quando o cliente está pronto: daí temos as guilds reais
    await this.client.login(this.token);
    this.guildsCache = [...this.client.guilds.cache.values()].map((g) => ({
      id: g.id,
      name: g.name,
      initials: g.name.slice(0, 2).toUpperCase(),
      members: g.memberCount ?? 0,
      role: "membro",
    }));
    console.log(`bot conectado como ${this.client.user.tag} · ${this.guildsCache.length} servidor(es)`);
  }

  /** guilds reais em que o bot está. Vazio no mock. */
  listGuilds() {
    return this.guildsCache;
  }

  emit(kind, data) {
    if (this.onEmit) this.onEmit(kind, data);
  }

  /** registra slash commands no Discord */
  async registerCommands(commands) {
    if (!this.token || !this.appId || !this.discord) return { skipped: true, reason: "sem token/app id" };
    if (!commands.length) return { count: 0 };
    const { REST, Routes } = this.discord;
    const rest = new REST({ version: "10" }).setToken(this.token);
    const body = commands.map((c) => ({
      name: c.name,
      description: (c.description || c.name).slice(0, 100),
      // sem opções declaradas, um campo livre única: `/pagar argumentos:<@alvo> 50`.
      // Sem isso o slash command chegaria sem argumento nenhum.
      options: c.options?.length
        ? c.options
        : [{ type: 3, name: "argumentos", description: "argumentos do comando", required: false }],
    }));
    await rest.put(Routes.applicationCommands(this.appId), { body });
    return { count: body.length };
  }

  async sendMessage({ channelId, content, ephemeral, interactionId }) {
    const i = interactionId ? this.interactions.get(interactionId) : null;
    if (i) {
      const timer = this.interactionTimers?.get(interactionId);
      if (timer) { clearTimeout(timer); this.interactionTimers.delete(interactionId); }
      this.answered?.add(interactionId);

      // depois de um deferReply a resposta vai por editReply
      if (i.deferred && !i.replied) return i.editReply({ content });
      if (i.replied || i.deferred) return i.followUp({ content, ephemeral: !!ephemeral });
      return i.reply({ content, ephemeral: !!ephemeral });
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
