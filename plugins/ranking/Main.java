import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Plugin de ranking — exemplo em Java, rodado com `java Main.java` (single-file source launch).
 *
 * Protocolo: JSON-RPC 2.0, uma mensagem JSON por linha, em stdin/stdout.
 * Sem biblioteca JSON externa: o subconjunto usado aqui é simples de ler na mão.
 */
public final class Main {

    private static final BufferedReader IN =
            new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    private static final PrintStream OUT =
            new PrintStream(System.out, true, StandardCharsets.UTF_8);

    private static int seq = 0;
    private static int limit = 10;

    // ─────────────────────────────────────────────────────────── protocolo

    static void send(String json) {
        OUT.print(json);
        OUT.print('\n');
        OUT.flush();
    }

    static String quote(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\r' -> b.append("\\r");
                case '\t' -> b.append("\\t");
                default -> {
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
                }
            }
        }
        return b.append('"').toString();
    }

    static String rawId(String line) {
        Matcher m = Pattern.compile("\"id\"\\s*:\\s*(\"[^\"]*\"|\\d+)").matcher(line);
        return m.find() ? m.group(1) : "null";
    }

    static String strField(String line, String field) {
        Matcher m = Pattern.compile("\"" + field + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(line);
        if (!m.find()) return null;
        return m.group(1).replace("\\\"", "\"").replace("\\\\", "\\");
    }

    static int intField(String line, String field, int fallback) {
        Matcher m = Pattern.compile("\"" + field + "\"\\s*:\\s*(-?\\d+)").matcher(line);
        return m.find() ? Integer.parseInt(m.group(1)) : fallback;
    }

    static void reply(String id, String resultJson) {
        send("{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":" + resultJson + "}");
    }

    static void fail(String id, int code, String message) {
        send("{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"error\":{\"code\":" + code + ",\"message\":" + quote(message) + "}}");
    }

    /** Chamada síncrona ao core. Lê linhas até achar a resposta do nosso id. */
    static String core(String method, String paramsJson) throws Exception {
        String id = String.valueOf(++seq);
        send("{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"method\":" + quote(method) + ",\"params\":" + paramsJson + "}");

        while (true) {
            String line = IN.readLine();
            if (line == null) throw new IllegalStateException("core fechou a conexão");
            line = line.trim();
            if (line.isEmpty()) continue;
            String rid = rawId(line);
            if (rid.equals(id)) return line;
            // requisição do core durante a espera: só confirmamos
            reply(rid, "{\"ok\":true}");
        }
    }

    // ─────────────────────────────────────────────────────────── domínio

    static String coins(int n) {
        StringBuilder out = new StringBuilder();
        String s = Integer.toString(Math.abs(n));
        for (int i = 0; i < s.length(); i++) {
            if (i > 0 && (s.length() - i) % 3 == 0) out.append('.');
            out.append(s.charAt(i));
        }
        return (n < 0 ? "-" : "") + out;
    }

    /** Extrai [{userId,balance}] da resposta de economy.top. */
    static List<String[]> parseEntries(String response) {
        List<String[]> out = new ArrayList<>();
        Matcher m = Pattern.compile("\\{\"user_id\"\\s*:\\s*\"([^\"]+)\"\\s*,\\s*\"balance\"\\s*:\\s*(-?\\d+)\\}")
                .matcher(response);
        Pattern alt = Pattern.compile("\"userId\"\\s*:\\s*\"([^\"]+)\"[^}]*\"balance\"\\s*:\\s*(-?\\d+)");
        Matcher m2 = alt.matcher(response);
        while (m.find()) out.add(new String[] { m.group(1), m.group(2) });
        if (out.isEmpty()) {
            while (m2.find()) out.add(new String[] { m2.group(1), m2.group(2) });
        }
        return out;
    }

    static String cmdTop(String guildId) throws Exception {
        String resp = core("economy.top", "{\"guildId\":" + quote(guildId) + ",\"limit\":" + limit + "}");
        List<String[]> entries = parseEntries(resp);

        if (entries.isEmpty()) {
            return "[{\"type\":\"reply\",\"content\":\"Ainda ninguém tem moedas neste servidor.\"}]";
        }

        StringBuilder sb = new StringBuilder("**Maiores fortunas**\\n\\n");
        int pos = 1;
        for (String[] e : entries) {
            sb.append(pos).append(". <@").append(e[0]).append("> — **")
              .append(coins(Integer.parseInt(e[1]))).append(" moedas**\\n");
            pos++;
        }
        return "[{\"type\":\"reply\",\"content\":" + quote(sb.toString()) + "}]";
    }

    static String cmdMeuTop(String userId, String guildId) throws Exception {
        String resp = core("economy.top", "{\"guildId\":" + quote(guildId) + ",\"limit\":500}");
        List<String[]> entries = parseEntries(resp);

        for (int i = 0; i < entries.size(); i++) {
            if (entries.get(i)[0].equals(userId)) {
                String content = "Você está no **" + (i + 1) + "º lugar** com **"
                        + coins(Integer.parseInt(entries.get(i)[1])) + " moedas**.";
                return "[{\"type\":\"reply\",\"content\":" + quote(content) + "}]";
            }
        }
        return "[{\"type\":\"reply\",\"content\":\"Você ainda não aparece no ranking.\"}]";
    }

    // ─────────────────────────────────────────────────────────── roteamento

    static void onRequest(String line) {
        String id = rawId(line);
        String method = strField(line, "method");

        try {
            switch (method) {
                case "initialize" -> {
                    int lim = intField(line, "limit", 0);
                    if (lim > 0) limit = lim;
                    reply(id, "{\"ok\":true}");
                }
                case "handleCommand" -> {
                    String command = strField(line, "command");
                    String userId = strField(line, "userId");
                    String guildId = strField(line, "guildId");
                    if (userId == null) userId = "0";
                    if (guildId == null) guildId = "0";

                    String result = switch (command == null ? "" : command) {
                        case "top" -> cmdTop(guildId);
                        case "meu-top" -> cmdMeuTop(userId, guildId);
                        default -> "[{\"type\":\"reply\",\"content\":" + quote("Comando `" + command + "` não existe aqui.") + "}]";
                    };
                    reply(id, result);
                }
                case "handleEvent" -> reply(id, "[]");
                case "health" -> reply(id, "{\"ok\":true,\"detail\":\"ranking ativo\"}");
                case "shutdown" -> {
                    reply(id, "{\"ok\":true}");
                    System.exit(0);
                }
                default -> fail(id, -32601, "método desconhecido: " + method);
            }
        } catch (Exception e) {
            System.err.println("[error] " + e.getMessage());
            fail(id, -32000, e.getMessage() == null ? "erro" : e.getMessage());
        }
    }

    public static void main(String[] args) throws Exception {
        System.err.println("[info] ranking iniciado");
        String line;
        while ((line = IN.readLine()) != null) {
            line = line.trim();
            if (line.isEmpty()) continue;
            onRequest(line);
        }
    }
}
