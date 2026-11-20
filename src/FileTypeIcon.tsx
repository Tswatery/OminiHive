import {
  Database, File, FileArchive, FileAudio, FileCode2, FileImage,
  FileJson, FileSpreadsheet, FileTerminal, FileText, FileVideo,
  Folder, FolderOpen, GitBranch, Presentation, Settings2
} from 'lucide-react'

function MiniBadge({ text, bg, fg = '#fff', size = 15 }: { text: string; bg: string; fg?: string; size?: number }) {
  return (
    <span
      className="ftype-badge"
      style={{
        width: size,
        height: size,
        background: bg,
        color: fg,
        fontSize: text.length > 2 ? 6.5 : 7.5
      }}
      aria-hidden="true"
    >
      {text}
    </span>
  )
}

export function FileTypeIcon({
  name = '',
  ext: rawExt,
  isDir = false,
  isOpen = false,
  size = 15
}: {
  name?: string
  ext?: string
  isDir?: boolean
  isOpen?: boolean
  size?: number
}) {
  if (isDir) {
    return isOpen
      ? <FolderOpen size={size} className="ficon dir" />
      : <Folder size={size} className="ficon dir" />
  }

  const lower = name.toLowerCase()
  const ext = (rawExt ?? (lower.includes('.') ? '.' + lower.split('.').pop() : '')).toLowerCase()

  if (lower === '.gitignore' || lower === '.gitattributes' || lower === '.gitmodules') {
    return <GitBranch size={size} className="ficon git" />
  }
  if (lower === 'dockerfile' || lower.startsWith('docker-compose')) {
    return <MiniBadge text="DK" bg="#0284c7" size={size} />
  }

  // Markdown
  if (ext === '.md' || ext === '.mdx') {
    return <MiniBadge text="M↓" bg="#16a34a" size={size} />
  }

  // Office & Documents
  if (ext === '.pptx' || ext === '.ppt' || ext === '.key' || ext === '.odp') {
    return <Presentation size={size} className="ficon ppt" />
  }
  if (ext === '.docx' || ext === '.doc' || ext === '.pages' || ext === '.rtf' || ext === '.odt') {
    return <MiniBadge text="W" bg="#2563eb" size={size} />
  }
  if (ext === '.xlsx' || ext === '.xls' || ext === '.csv' || ext === '.numbers' || ext === '.ods') {
    return <FileSpreadsheet size={size} className="ficon xls" />
  }
  if (ext === '.pdf') {
    return <MiniBadge text="PDF" bg="#dc2626" size={size} />
  }

  // Media
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.ico', '.heic', '.tiff', '.tif', '.psd'].includes(ext)) {
    return <FileImage size={size} className="ficon img" />
  }
  if (['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'].includes(ext)) {
    return <FileVideo size={size} className="ficon video" />
  }
  if (['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac'].includes(ext)) {
    return <FileAudio size={size} className="ficon audio" />
  }
  if (['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.rar', '.7z', '.dmg'].includes(ext)) {
    return <FileArchive size={size} className="ficon archive" />
  }

  // Languages
  if (ext === '.ts' || ext === '.tsx') return <MiniBadge text="TS" bg="#2563eb" size={size} />
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return <MiniBadge text="JS" bg="#ca8a04" size={size} />
  if (ext === '.py' || ext === '.ipynb') return <MiniBadge text="PY" bg="#3b82f6" size={size} />
  if (ext === '.go') return <MiniBadge text="GO" bg="#0891b2" size={size} />
  if (ext === '.rs') return <MiniBadge text="RS" bg="#c2410c" size={size} />
  if (ext === '.tex' || ext === '.bib') return <MiniBadge text="TEX" bg="#0f766e" size={size} />
  if (ext === '.html' || ext === '.htm') return <MiniBadge text="</>" bg="#ea580c" size={size} />
  if (ext === '.css' || ext === '.scss' || ext === '.less') return <MiniBadge text="#" bg="#0284c7" size={size} />
  if (ext === '.vue') return <MiniBadge text="V" bg="#10b981" size={size} />
  if (ext === '.svelte') return <MiniBadge text="S" bg="#ea580c" size={size} />

  // Data / Config / Shell / DB
  if (ext === '.json' || ext === '.jsonl') return <FileJson size={size} className="ficon json" />
  if (['.yml', '.yaml', '.toml', '.xml', '.ini', '.env', '.conf'].includes(ext)) {
    return <Settings2 size={size} className="ficon config" />
  }
  if (['.sh', '.zsh', '.bash', '.fish', '.ps1', '.bat'].includes(ext)) {
    return <FileTerminal size={size} className="ficon shell" />
  }
  if (['.sql', '.sqlite', '.sqlite3', '.db'].includes(ext)) {
    return <Database size={size} className="ficon db" />
  }
  if (['.java', '.kt', '.swift', '.c', '.cpp', '.cc', '.h', '.hpp', '.rb', '.php', '.dart', '.lua', '.r'].includes(ext)) {
    return <FileCode2 size={size} className="ficon code" />
  }
  if (ext === '.txt' || ext === '.log') {
    return <FileText size={size} className="ficon text" />
  }

  return <File size={size} className="ficon" />
}
