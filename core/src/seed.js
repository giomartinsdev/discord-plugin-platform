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
  { path: join(ROOT, "plugins", "pets"), guilds: ["1201", "1202"] },
  { path: join(ROOT, "plugins", "economia"), guilds: ["1201", "1202", "1203"] },
  { path: join(ROOT, "plugins", "loja"), guilds: ["1201"] },
  { path: join(ROOT, "plugins", "cassino"), guilds: ["1201", "1203"] },
  { path: join(ROOT, "plugins", "moderacao"), guilds: ["1201"] },
  { path: join(ROOT, "plugins", "ranking"), guilds: ["1201", "1203"] },
];

export async function seedAll(app) {
  const installed = [];
  for (const entry of PLUGIN_DIRS) {
    try {
      const res = await app.core.install({ dir: entry.path, guilds: entry.guilds, build: false });
      installed.push(res);
    } catch (err) {
      app.store.log({ level: "error", source: "seed", message: `falha ao instalar ${entry.path}: ${err.message}` });
      console.error(`  ✗ ${entry.path}: ${err.message}`);
    }
  }

  // dados de exemplo de economia, para o painel não nascer vazio
  const g = "1201";
  const people = [["4410", 1240], ["8891", 980], ["3320", 760], ["7712", 640], ["2299", 410], ["5150", 300]];
  for (const [userId, balance] of people) app.store.econGrant(g, userId, balance);

  app.store.setSetting("seeded", true);
  return { installed, guildId: g, people: people.length };
}
