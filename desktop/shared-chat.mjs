const invalidLink = '请粘贴 ChatGPT 或 Gemini 的公开对话分享链接'
const missingContent = '分享链接没有可读取的对话，请确认它仍然公开有效'

export function identifyShare(input) {
  let url
  try { url = new URL(input.trim()) } catch { throw Error(invalidLink) }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw Error(invalidLink)
  const chatGPT = url.hostname === 'chatgpt.com'
  const shortGemini = url.hostname === 'g.co'
  if (!chatGPT && !shortGemini && url.hostname !== 'gemini.google.com') throw Error(invalidLink)
  const match = shortGemini
    ? /^\/gemini\/share\/([\w-]+)\/?$/.exec(url.pathname)
    : /^\/share\/([\w-]+)\/?$/.exec(url.pathname)
  if (!match || match[1].length > 128) throw Error(invalidLink)
  return { agent: chatGPT ? 'ChatGPT' : 'Gemini', id: match[1] }
}

export function parseChatGPTShare(data) {
  const turns = []
  const visited = new Set()
  let id = data?.current_node
  while (id) {
    const node = data.mapping?.[id]
    if (!node || visited.has(id)) throw Error('分享对话的消息链不完整')
    visited.add(id)
    id = node.parent
    const msg = node.message
    const role = msg?.author?.role
    if (role !== 'assistant' && role !== 'user') continue
    if (msg.metadata?.is_visually_hidden_from_conversation || (msg.recipient && msg.recipient !== 'all')) continue
    if (msg.channel && !['final', 'commentary'].includes(msg.channel)) continue
    if (!['text','multimodal_text'].includes(msg.content?.content_type)) continue
    let text = (msg.content.parts || []).filter(p => typeof p === 'string').join('\n').trim()
    for (const ref of msg.metadata?.content_references || []) {
      if (ref.matched_text && ref.alt) text = text.replaceAll(ref.matched_text, () => ref.alt)
    }
    const files = (msg.metadata?.attachments || []).map(f => f.name).filter(Boolean)
    if (files.length) text += '\n\n附件：' + files.join('、')
    else if (msg.content.parts?.some(p => p?.content_type === 'image_asset_pointer')) text += '\n\n[图片附件]'
    if (text.trim()) turns.push({ role, text: text.trim(), time: Number(msg.create_time) * 1000 })
  }
  if (!turns.length) throw Error(missingContent)
  return { agent: 'ChatGPT', title: data.title || 'ChatGPT 分享对话', turns: turns.reverse() }
}

// Gemini's public page reads the conversation through a length-framed batch response.
export function parseGeminiShare(raw, id) {
  for (const line of raw.split('\n')) {
    if (!line.startsWith('[[')) continue
    const frame = JSON.parse(line).find(row => row[0] === 'wrb.fr' && row[1] === 'ujx1Bf')
    if (!frame?.[2]) continue
    const root = JSON.parse(frame[2])?.[0]
    if (root?.[3] !== id || !Array.isArray(root[1])) throw Error(missingContent)
    const turns = []
    for (const exchange of root[1]) {
      const time = Number(exchange[4]?.[0]) * 1000
      const candidate = exchange[3]?.[0]?.[0]
      const before = turns.length
      for (const [role, parts] of [['user', exchange[2]?.[0]], ['assistant', candidate?.[1]]]) {
        const text = Array.isArray(parts) ? parts.filter(p => typeof p === 'string').join('\n').trim() : ''
        if (text) turns.push({ role, text, time })
      }
      if (turns.length === before) throw Error('Gemini 分享中有无法读取的轮次')
    }
    if (turns.length) return { agent: 'Gemini', title: root[2]?.[1]?.trim() || 'Gemini 分享对话', turns }
  }
  throw Error(missingContent)
}

export async function readSharedChat(input, fetchPublic) {
  const { agent, id } = identifyShare(input)
  let endpoint, request
  if (agent === 'ChatGPT') {
    endpoint = 'https://chatgpt.com/backend-api/share/' + id
    request = { headers: { Accept: 'application/json' } }
  } else {
    const query = new URLSearchParams({ rpcids: 'ujx1Bf', 'source-path': '/share/' + id, hl: 'en-US', rt: 'c' })
    endpoint = 'https://gemini.google.com/_/BardChatUi/data/batchexecute?' + query
    const batch = [[['ujx1Bf', JSON.stringify([null, id, [4]]), null, 'generic']]]
    request = { method: 'POST', headers: { 'X-Same-Domain': '1', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ 'f.req': JSON.stringify(batch) }).toString() }
  }
  try {
    const response = await fetchPublic(endpoint, { ...request, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw Error(agent + ' 分享读取失败（HTTP ' + response.status + '）')
    return agent === 'ChatGPT' ? parseChatGPTShare(await response.json()) : parseGeminiShare(await response.text(), id)
  } catch (e) {
    if (e instanceof SyntaxError) throw Error(missingContent)
    throw e
  }
}
