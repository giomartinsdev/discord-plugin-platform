# frozen_string_literal: true

# Plugin de moderação — exemplo em Ruby 2.6.
#
# Protocolo: JSON-RPC 2.0, uma mensagem JSON por linha, em stdin/stdout.
# O plugin nunca recebe token do Discord: devolve ações e o core executa.

require 'json'
require 'time'

$stdout.sync = true
$stderr.sync = true

@seq = 0
@config = {}

def log(message, level = 'info')
  $stderr.puts("[#{level}] #{message}")
end

def send_msg(obj)
  $stdout.puts(JSON.generate(obj))
end

def reply(id, result)
  send_msg('jsonrpc' => '2.0', 'id' => id, 'result' => result)
end

def fail(id, code, message)
  send_msg('jsonrpc' => '2.0', 'id' => id, 'error' => { 'code' => code, 'message' => message })
end

# Chamada síncrona ao core: escreve o pedido e lê linhas até a resposta.
def core(method, params)
  @seq += 1
  id = "r#{@seq}"
  send_msg('jsonrpc' => '2.0', 'id' => id, 'method' => method, 'params' => params)

  loop do
    line = $stdin.gets
    raise 'core fechou a conexão' if line.nil?

    text = line.strip
    next if text.empty?

    begin
      msg = JSON.parse(text)
    rescue JSON::ParserError
      log("linha inválida: #{text[0, 60]}", 'warn')
      next
    end

    if msg.key?('method')
      handle_inline(msg)
      next
    end
    next unless msg['id'] == id

    raise(msg['error']['message']) if msg['error']

    return msg['result'] || {}
  end
end

def handle_inline(msg)
  case msg['method']
  when 'log'
    log(msg.dig('params', 'message').to_s)
  end
  reply(msg['id'], { 'ok' => true })
end

def clean_id(raw)
  raw.to_s.gsub(/[<@!>]/, '')
end

# ── comandos ──

def cmd_aviso(args, user_id, guild_id)
  target = clean_id(args[0])
  return [{ 'type' => 'reply', 'content' => 'Use `!aviso @alguém motivo`.' }] if target.empty?

  reason = args[1..-1].join(' ')
  reason = 'sem motivo informado' if reason.empty?

  key = "warn:#{target}"
  hist = core('kv.get', 'guildId' => guild_id, 'key' => key)['value'] || []
  hist << { 'by' => user_id, 'reason' => reason, 'at' => Time.now.utc.iso8601 }
  core('kv.set', 'guildId' => guild_id, 'key' => key, 'value' => hist)

  limit = (@config[guild_id] || {})['max_warnings'] || 3
  count = hist.length

  if count >= limit
    mute = ((@config[guild_id] || {})['mute_role'] || '9100').to_s
    return [
      { 'type' => 'reply', 'content' => "<@#{target}> recebeu o aviso #{count} de #{limit}. Limite atingido — cargo de silenciado aplicado." },
      { 'type' => 'addRole', 'userId' => target, 'roleId' => mute },
    ]
  end

  [{ 'type' => 'reply', 'content' => "<@#{target}> recebeu um aviso (#{count}/#{limit}). Motivo: #{reason}" }]
end

def cmd_historico(args, _user_id, guild_id)
  target = clean_id(args[0])
  return [{ 'type' => 'reply', 'content' => 'Use `!historico @alguém`.' }] if target.empty?

  hist = core('kv.get', 'guildId' => guild_id, 'key' => "warn:#{target}")['value'] || []
  if hist.empty?
    return [{ 'type' => 'reply', 'content' => "<@#{target}> não tem nenhuma punição registrada." }]
  end

  lines = ["**Histórico de <@#{target}>**", '']
  hist.each_with_index do |h, i|
    lines << "#{i + 1}. #{h['reason']} — por <@#{h['by']}>"
  end
  [{ 'type' => 'reply', 'content' => lines.join("\n") }]
end

def cmd_banir(args, user_id, guild_id)
  target = clean_id(args[0])
  return [{ 'type' => 'reply', 'content' => 'Use `!banir @alguém motivo`.' }] if target.empty?
  return [{ 'type' => 'reply', 'content' => 'Não dá para banir a si mesmo.' }] if target == user_id.to_s

  reason = args[1..-1].join(' ')
  reason = 'sem motivo informado' if reason.empty?

  hist = core('kv.get', 'guildId' => guild_id, 'key' => "warn:#{target}")['value'] || []
  hist << { 'by' => user_id, 'reason' => "banimento: #{reason}", 'at' => Time.now.utc.iso8601 }
  core('kv.set', 'guildId' => guild_id, 'key' => "warn:#{target}", 'value' => hist)

  [
    { 'type' => 'reply', 'content' => "<@#{target}> foi removido do servidor. Motivo: #{reason}" },
    { 'type' => 'kick', 'userId' => target, 'reason' => reason },
  ]
end

COMMANDS = {
  'aviso' => method(:cmd_aviso),
  'historico' => method(:cmd_historico),
  'banir' => method(:cmd_banir)
}.freeze

def on_request(msg)
  method = msg['method']
  params = msg['params'] || {}
  guild_id = (params['guildId'] || '0').to_s

  case method
  when 'initialize'
    (params['guilds'] || []).each do |g|
      cfg = core('config.get', 'guildId' => g['id'])['config'] || {}
      @config[g['id']] = cfg
    end
    log("inicializado para #{(params['guilds'] || []).length} servidor(es)")
    reply(msg['id'], 'ok' => true)

  when 'handleCommand'
    handler = COMMANDS[params['command']]
    actions = if handler
                handler.call(params['args'] || [], params['userId'].to_s, guild_id)
              else
                [{ 'type' => 'reply', 'content' => "Comando `#{params['command']}` não existe aqui." }]
              end
    reply(msg['id'], actions)

  when 'handleEvent'
    reply(msg['id'], [])

  when 'health'
    reply(msg['id'], 'ok' => true, 'detail' => 'moderação ativa')

  when 'shutdown'
    reply(msg['id'], 'ok' => true)
    exit 0

  else
    fail(msg['id'], -32_601, "método desconhecido: #{method}")
  end
rescue StandardError => e
  log("erro em #{method}: #{e.message}", 'error')
  fail(msg['id'], -32_000, e.message)
end

log('moderação iniciada')

while (line = $stdin.gets)
  text = line.strip
  next if text.empty?

  begin
    msg = JSON.parse(text)
  rescue JSON::ParserError
    log("linha inválida: #{text[0, 60]}", 'warn')
    next
  end

  on_request(msg) if msg.key?('method')
end
