/**
 * Turn an IPC / runtime error into a user-facing message.
 *
 * Electron wraps errors thrown in the main process as
 *   "Error invoking remote method 'send': Error: <real message>"
 * so strip that envelope (and any leading "Error:") but keep the real message intact,
 * including any later "Error:" that is part of the message itself.
 */
export function cleanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? '')
  const msg = raw
    .replace(/^Error:\s*/i, '')
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
  return msg || '未知错误'
}
