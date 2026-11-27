import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");

export function defaultGuilds() {
  return [
    { id: "1201", name: "Servidor Dev BR", initials: "DV", members: 2431, role: "proprietário" },
    { id: "1202", name: "Casinha do Gio", initials: "CG", members: 87, role: "proprietário" },
    { id: "1203", name: "Bot Lab", initials: "BL", members: 512, role: "administrador" },
  ];
}

const PLUGIN_DIRS = [
  { path: join(ROOT, "plugins", "pets") },
  { path: join(ROOT, "plugins", "economia") },
  { path: join(ROOT, "plugins", "loja") },
  { path: join(ROOT, "plugins", "cassino") },
  { path: join(ROOT, "plugins", "moderacao") },
  { path: join(ROOT, "plugins", "ranking") },
];

/**
 * Instala os seis exemplos. As guilds vêm de `app.core.guilds`, então funciona
 * tanto no mock (guilds de demonstração) quanto no Discord real (gateway).
 */
export async function seedAll(app) {
  const targetGuilds = (app.core.guilds ?? []).map((g) => g.id);
  if (!targetGuilds.length) throw new Error("nenhum servidor disponível: o bot está em algum servidor?");

  const installed = [];
  for (const entry of PLUGIN_DIRS) {
    try {
      const res = await app.core.install({ dir: entry.path, guilds: targetGuilds, build: false });
      installed.push(res);
    } catch (err) {
      app.store.log({ level: "error", source: "seed", message: `falha ao instalar ${entry.path}: ${err.message}` });
      console.error(`  ✗ ${entry.path}: ${err.message}`);
    }
  }

  // dados de demonstração só fazem sentido sem Discord: no real os saldos são dos membros
  if (app.adapter?.kind === "mock") {
    const g = targetGuilds[0];
    const people = [["4410", 1240], ["8891", 980], ["3320", 760], ["7712", 640], ["2299", 410], ["5150", 300]];
    for (const [userId, balance] of people) app.store.econGrant(g, userId, balance);
  }

  app.store.setSetting("seeded", true);
  return { installed, guildId: targetGuilds[0], guilds: targetGuilds };
}
