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

    // login resolve antes do gateway popular as guilds: esperar o ready de verdade.
    // O cache do gateway pode chegar incompleto, então o REST é a fonte da verdade.
    this.ready = new Promise((resolve, reject) => {
      this.client.once(Events.ClientReady, resolve);
      this.client.login(this.token).catch(reject);
    });
    await this.ready;

    this.guildsCache = await this.fetchGuilds();
    console.log(`bot conectado como ${this.client.user.tag} · ${this.guildsCache.length} servidor(es)`);
  }

  /** guilds reais em que o bot está. Vazio no mock. */
  listGuilds() {
    return this.guildsCache;
  }

  /** REST primeiro (sempre completo); cache do gateway como reserva */
  async fetchGuilds() {
    let rows = [];
    try {
      const map = await this.client.guilds.fetch();
      rows = [...map.values()].map((g) => ({ id: g.id, name: g.name }));
    } catch {
      rows = [...this.client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name }));
    }
    return rows
      .filter((g) => g.id)
      .map((g) => {
        const name = g.name ?? g.id;
        return {
          id: g.id,
          name,
          initials: name.slice(0, 2).toUpperCase(),
          members: this.client.guilds.cache.get(g.id)?.memberCount ?? 0,
          role: "membro",
        };
      });
  }

  emit(kind, data) {
    if (this.onEmit) this.onEmit(kind, data);
  }

  /**
   * Registra slash commands por servidor: cada guild recebe só os comandos dos
   * plugins instalados nela. `byGuild` é { guildId: commands[] }.
   * Guilda sem comando tem o registro limpo.
   */
  async registerCommands(byGuild) {
    if (!this.token || !this.appId || !this.discord) return { skipped: true, reason: "sem token/app id" };
    const { REST, Routes } = this.discord;
    const rest = new REST({ version: "10" }).setToken(this.token);

    const shape = (c) => ({
      name: c.name,
      description: (c.description || c.name).slice(0, 100),
      // sem opções declaradas, um campo livre único: `/pagar argumentos:<@alvo> 50`.
      // Sem isso o slash command chegaria sem argumento nenhum.
      options: c.options?.length
        ? c.options
        : [{ type: 3, name: "argumentos", description: "argumentos do comando", required: false }],
    });

    // O Discord limita bulk overwrite com força (o segundo PUT seguido espera ~1 min).
    // Só reenvia o que mudou: comparar o corpo com o último aplicado por servidor.
    this.commandsSent ??= new Map();

    // limpa comandos globais de versões antigas: eles apareceriam em todo servidor
    let clearedGlobal = false;
    if (!this.globalCleared) {
      try {
        await rest.put(Routes.applicationCommands(this.appId), { body: [] });
        this.globalCleared = true;
        clearedGlobal = true;
      } catch { /* pode falhar se não houver nenhum; segue */ }
    }

    let count = 0;
    const failed = [];
    const skippedGuilds = [];
    const seen = new Set();
    for (const [guildId, commands] of Object.entries(byGuild ?? {})) {
      seen.add(guildId);
      const body = commands.map(shape);
      const key = JSON.stringify(body);
      if (this.commandsSent.get(guildId) === key) {
        skippedGuilds.push(guildId);
        continue;
      }
      try {
        await rest.put(Routes.applicationGuildCommands(this.appId, guildId), { body });
        this.commandsSent.set(guildId, key);
        count += body.length;
      } catch (err) {
        // sem permissão `applications.commands` naquele servidor: não derruba os outros
        failed.push({ guildId, error: err.message });
      }
    }
    // servidor que saiu da lista não precisa mais de comandos registrados
    for (const guildId of [...this.commandsSent.keys()]) {
      if (seen.has(guildId)) continue;
      try { await rest.put(Routes.applicationGuildCommands(this.appId, guildId), { body: [] }); } catch {}
      this.commandsSent.delete(guildId);
    }

    return { count, guilds: Object.keys(byGuild ?? {}).length, clearedGlobal, failed, unchanged: skippedGuilds.length };
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
