// Plugin de loja — exemplo em Go.
//
// Protocolo: JSON-RPC 2.0, uma mensagem JSON por linha, em stdin/stdout.
// O plugin nunca vê o token do Discord: devolve Actions e o core executa.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
)

type rpcMsg struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type action map[string]any

type item struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Price int    `json:"price"`
	Role  string `json:"role"`
}

var catalog = []item{
	{"vip", "Cargo VIP", 1500, "9001"},
	{"artista", "Cargo Artista", 800, "9002"},
	{"gamer", "Cargo Gamer", 600, "9003"},
	{"coruja", "Cargo Coruja", 400, "9004"},
}

var (
	in       = bufio.NewScanner(os.Stdin)
	seq      = 0
	prefix   = "5"
	maxPerUs = 10
)

func send(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		logf("falha ao serializar: %v", err)
		return
	}
	os.Stdout.Write(append(b, '\n'))
}

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[info] "+format+"\n", args...)
}

func reply(id json.RawMessage, result any) {
	send(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func fail(id json.RawMessage, code int, message string) {
	send(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": message}})
}

// coreCall chama o core de forma síncrona. Como o core serializa chamadas,
// nenhuma outra requisição chega enquanto esperamos — só respostas.
func coreCall(method string, params map[string]any) (map[string]any, error) {
	seq++
	id := fmt.Sprintf("g%d", seq)
	send(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})

	for in.Scan() {
		line := strings.TrimSpace(in.Text())
		if line == "" {
			continue
		}
		var msg rpcMsg
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			logf("linha inválida: %.60s", line)
			continue
		}
		if msg.Method != "" {
			handleInline(msg)
			continue
		}
		var gotID string
		json.Unmarshal(msg.ID, &gotID)
		if gotID != id {
			continue
		}
		if msg.Error != nil {
			return nil, fmt.Errorf("%s", msg.Error.Message)
		}
		var out map[string]any
		json.Unmarshal(msg.Result, &out)
		return out, nil
	}
	return nil, fmt.Errorf("core fechou a conexão")
}

func handleInline(msg rpcMsg) {
	switch msg.Method {
	case "log":
		var p struct{ Message string }
		json.Unmarshal(msg.Params, &p)
		logf("%s", p.Message)
		reply(msg.ID, map[string]any{"ok": true})
	default:
		reply(msg.ID, map[string]any{"ok": true})
	}
}

func num(v any) int {
	if f, ok := v.(float64); ok {
		return int(f)
	}
	return 0
}

func coins(n int) string {
	s := strconv.Itoa(n)
	var out []string
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ".")
		}
		out = append(out, string(c))
	}
	return strings.Join(out, "")
}

/* ── comandos ── */

func cmdLoja(args []string) []action {
	lines := []string{"**Loja**", ""}
	for _, it := range catalog {
		lines = append(lines, fmt.Sprintf("`%s` · **%s** — %s moedas", it.ID, it.Name, coins(it.Price)))
	}
	lines = append(lines, "", "Compre com `!comprar <item>`.")
	return []action{{"type": "reply", "content": strings.Join(lines, "\n")}}
}

func cmdComprar(args []string, userID, guildID string) []action {
	if len(args) == 0 {
		return []action{{"type": "reply", "content": "Use `!comprar <item>`. Veja os itens com `!loja`."}}
	}
	var picked *item
	for i := range catalog {
		if catalog[i].ID == strings.ToLower(args[0]) {
			picked = &catalog[i]
			break
		}
	}
	if picked == nil {
		return []action{{"type": "reply", "content": "Item não encontrado. Veja a lista com `!loja`."}}
	}

	invKey := "inv:" + userID
	inv, err := coreCall("kv.get", map[string]any{"guildId": guildID, "key": invKey})
	if err != nil {
		return []action{{"type": "reply", "content": "Não consegui consultar seu inventário agora."}}
	}

	owned := []string{}
	if raw, ok := inv["value"].([]any); ok {
		for _, v := range raw {
			if s, ok := v.(string); ok {
				owned = append(owned, s)
			}
		}
	}
	for _, o := range owned {
		if o == picked.ID {
			return []action{{"type": "reply", "content": fmt.Sprintf("Você já tem **%s**.", picked.Name)}}
		}
	}
	if len(owned) >= maxPerUs {
		return []action{{"type": "reply", "content": fmt.Sprintf("Você atingiu o limite de %d itens.", maxPerUs)}}
	}

	bal, err := coreCall("economy.get", map[string]any{"guildId": guildID, "userId": userID})
	if err != nil {
		return []action{{"type": "reply", "content": "Não consegui consultar seu saldo agora."}}
	}
	balance := num(bal["balance"])
	if balance < picked.Price {
		missing := picked.Price - balance
		return []action{{"type": "reply", "content": fmt.Sprintf("Faltam **%s moedas** para **%s**.", coins(missing), picked.Name)}}
	}

	if _, err := coreCall("economy.grant", map[string]any{
		"guildId": guildID, "userId": userID, "amount": -picked.Price, "reason": "compra: " + picked.ID,
	}); err != nil {
		return []action{{"type": "reply", "content": "A compra falhou ao debitar as moedas."}}
	}

	owned = append(owned, picked.ID)
	if _, err := coreCall("kv.set", map[string]any{"guildId": guildID, "key": invKey, "value": owned}); err != nil {
		return []action{{"type": "reply", "content": "A compra falhou ao salvar o inventário."}}
	}

	roleID := prefix + picked.Role[1:]
	return []action{
		{"type": "reply", "content": fmt.Sprintf("Comprou **%s** por %s moedas. Saldo: **%s**.", picked.Name, coins(picked.Price), coins(balance-picked.Price))},
		{"type": "addRole", "userId": userID, "roleId": roleID},
	}
}

func cmdInventario(args []string, userID, guildID string) []action {
	res, err := coreCall("kv.get", map[string]any{"guildId": guildID, "key": "inv:" + userID})
	if err != nil {
		return []action{{"type": "reply", "content": "Não consegui ler seu inventário agora."}}
	}
	raw, _ := res["value"].([]any)
	if len(raw) == 0 {
		return []action{{"type": "reply", "content": "Seu inventário está vazio. Veja a loja com `!loja`."}}
	}
	names := []string{}
	for _, v := range raw {
		if id, ok := v.(string); ok {
			for _, it := range catalog {
				if it.ID == id {
					names = append(names, it.Name)
				}
			}
		}
	}
	sort.Strings(names)
	return []action{{"type": "reply", "content": "**Seu inventário**\n" + strings.Join(names, "\n")}}
}

/* ── protocolo ── */

func onRequest(msg rpcMsg) {
	var params struct {
		Command string   `json:"command"`
		Args    []string `json:"args"`
		UserID  string   `json:"userId"`
		GuildID string   `json:"guildId"`
	}
	json.Unmarshal(msg.Params, &params)

	switch msg.Method {
	case "initialize":
		var p struct {
			Guilds []struct {
				ID     string         `json:"id"`
				Config map[string]any `json:"config"`
			} `json:"guilds"`
		}
		json.Unmarshal(msg.Params, &p)
		for _, g := range p.Guilds {
			if v, ok := g.Config["role_prefix"].(string); ok && v != "" {
				prefix = v
			}
			if v, ok := g.Config["max_per_user"].(float64); ok && v > 0 {
				maxPerUs = int(v)
			}
		}
		logf("inicializado para %d servidor(es)", len(p.Guilds))
		reply(msg.ID, map[string]any{"ok": true})

	case "handleCommand":
		var acts []action
		switch params.Command {
		case "loja":
			acts = cmdLoja(params.Args)
		case "comprar":
			acts = cmdComprar(params.Args, params.UserID, params.GuildID)
		case "inventario":
			acts = cmdInventario(params.Args, params.UserID, params.GuildID)
		default:
			acts = []action{{"type": "reply", "content": fmt.Sprintf("Comando `%s` não existe aqui.", params.Command)}}
		}
		reply(msg.ID, acts)

	case "handleEvent":
		reply(msg.ID, []action{})

	case "health":
		reply(msg.ID, map[string]any{"ok": true, "detail": "loja ativa"})

	case "shutdown":
		reply(msg.ID, map[string]any{"ok": true})
		os.Exit(0)

	default:
		fail(msg.ID, -32601, "método desconhecido: "+msg.Method)
	}
}

func main() {
	in.Buffer(make([]byte, 0, 1<<20), 1<<20)
	logf("loja iniciada")

	for in.Scan() {
		line := strings.TrimSpace(in.Text())
		if line == "" {
			continue
		}
		var msg rpcMsg
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			logf("linha inválida: %.60s", line)
			continue
		}
		if msg.Method == "" {
			continue
		}
		onRequest(msg)
	}
}
