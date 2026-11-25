/** Writes text to the system clipboard via the main process (navigator.clipboard is permission-blocked). */
export async function writeClipboardText(text: string): Promise<void> {
  if (window.hive?.copyText) {
    await window.hive.copyText(text)
    return
  }
  await navigator.clipboard.writeText(text)
}
