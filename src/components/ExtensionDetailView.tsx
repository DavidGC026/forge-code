import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStore } from '../store';
import {
  AlertTriangle,
  Blocks,
  CalendarDays,
  Download,
  ExternalLink,
  Loader2,
  PackageCheck,
  ShieldCheck,
  Star,
  Tag,
  Trash2,
} from 'lucide-react';
import type { MarketplaceExtension, MarketplaceExtensionDetail } from '../types';
import ExtensionSettingsSection from './ExtensionSettingsSection';
import ExtensionContributionsSection from './ExtensionContributionsSection';
import ExtensionRuntimeSection from './ExtensionRuntimeSection';

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function openExternal(url: string) {
  if (/^https?:\/\//i.test(url)) void window.electronAPI?.openExternal?.(url);
}

// ── Fallback fetch (browser dev mode, no Electron IPC) ──────────────────
async function fetchDetailFromRenderer(
  ext: MarketplaceExtension,
): Promise<MarketplaceExtensionDetail> {
  const res = await fetch(
    `https://open-vsx.org/api/${encodeURIComponent(ext.namespace)}/${encodeURIComponent(ext.name)}/latest`,
  );
  if (!res.ok) throw new Error(`Open VSX respondió ${res.status} al obtener la extensión.`);
  const meta: any = await res.json();

  let readme: string | null = null;
  if (typeof meta?.files?.readme === 'string') {
    try {
      const readmeRes = await fetch(meta.files.readme);
      if (readmeRes.ok) readme = await readmeRes.text();
    } catch {
      /* README is optional */
    }
  }

  const engines: Record<string, string> = {};
  if (meta?.engines && typeof meta.engines === 'object') {
    for (const [key, value] of Object.entries(meta.engines)) {
      if (typeof value === 'string') engines[key] = value;
    }
  }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);

  return {
    ...ext,
    version: str(meta?.version) ?? ext.version,
    description: str(meta?.description) ?? ext.description,
    downloadCount: typeof meta?.downloadCount === 'number' ? meta.downloadCount : ext.downloadCount,
    averageRating: typeof meta?.averageRating === 'number' ? meta.averageRating : ext.averageRating,
    reviewCount: typeof meta?.reviewCount === 'number' ? meta.reviewCount : ext.reviewCount,
    lastUpdated: str(meta?.timestamp) ?? ext.lastUpdated,
    readme,
    categories: Array.isArray(meta?.categories) ? meta.categories.filter((c: unknown) => typeof c === 'string') : [],
    tags: Array.isArray(meta?.tags)
      ? meta.tags.filter((t: unknown): t is string => typeof t === 'string' && !t.startsWith('__'))
      : [],
    license: str(meta?.license),
    homepage: str(meta?.homepage),
    repository: str(meta?.repository),
    bugs: str(meta?.bugs),
    engines,
    preRelease: Boolean(meta?.preRelease),
    publishedBy: str(meta?.publishedBy?.loginName),
  };
}

// ── Minimal markdown renderer ────────────────────────────────────────────
// READMEs come from Open VSX as markdown (often with embedded HTML badges).
// We render a safe subset as React elements — never innerHTML — so remote
// content can't inject markup. Unknown HTML is stripped to plain text.

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  // Convert HTML <img src="…"> to markdown images, then drop remaining tags.
  const cleaned = text
    .replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, '![]($1)')
    .replace(/<[^>]+>/g, '');

  const nodes: ReactNode[] = [];
  const pattern =
    /(!\[[^\]]*\]\([^)]+\))|(\[[^\]]+\]\([^)]+\))|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(cleaned)) !== null) {
    if (match.index > last) nodes.push(cleaned.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith('![')) {
      const m = token.match(/^!\[([^\]]*)\]\(([^)\s]+)/);
      if (m && /^https?:\/\//i.test(m[2])) {
        nodes.push(
          <img key={key} src={m[2]} alt={m[1]} className="inline-block max-h-5 align-middle" />,
        );
      }
    } else if (token.startsWith('[')) {
      const m = token.match(/^\[([^\]]+)\]\(([^)\s]+)/);
      if (m) {
        nodes.push(
          <a
            key={key}
            href="#"
            onClick={(e) => {
              e.preventDefault();
              openExternal(m[2]);
            }}
            className="text-forge-accent hover:underline"
          >
            {renderInline(m[1], key)}
          </a>,
        );
      }
    } else if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="px-1 py-0.5 rounded bg-forge-input text-[0.92em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      nodes.push(
        <strong key={key} className="text-forge-text-strong">
          {renderInline(token.slice(2, -2), key)}
        </strong>,
      );
    } else {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    }
    last = match.index + token.length;
  }
  if (last < cleaned.length) nodes.push(cleaned.slice(last));
  return nodes;
}

function MarkdownView({ source }: { source: string }) {
  const blocks = useMemo(() => {
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    const out: ReactNode[] = [];
    let i = 0;
    let key = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (/^\s*$/.test(line)) {
        i++;
        continue;
      }

      // Fenced code block
      const fence = line.match(/^```/);
      if (fence) {
        const code: string[] = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          code.push(lines[i]);
          i++;
        }
        i++; // closing fence
        out.push(
          <pre
            key={key++}
            className="my-2 p-3 rounded bg-forge-input/80 border border-forge-border/50 overflow-x-auto text-[12px] leading-relaxed"
          >
            <code>{code.join('\n')}</code>
          </pre>,
        );
        continue;
      }

      // Heading
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        const sizes = ['text-[20px]', 'text-[17px]', 'text-[15px]', 'text-[13px]', 'text-[12px]', 'text-[12px]'];
        out.push(
          <div
            key={key++}
            className={`${sizes[level - 1]} font-semibold text-forge-text-strong mt-4 mb-1.5 ${level <= 2 ? 'pb-1 border-b border-forge-border/40' : ''}`}
          >
            {renderInline(heading[2], `h${key}`)}
          </div>,
        );
        i++;
        continue;
      }

      // Horizontal rule
      if (/^(\s*[-*_]){3,}\s*$/.test(line)) {
        out.push(<hr key={key++} className="my-3 border-forge-border/50" />);
        i++;
        continue;
      }

      // Blockquote
      if (/^\s*>/.test(line)) {
        const quote: string[] = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push(
          <blockquote
            key={key++}
            className="my-2 pl-3 border-l-2 border-forge-accent/50 text-forge-text/70"
          >
            {renderInline(quote.join(' '), `q${key}`)}
          </blockquote>,
        );
        continue;
      }

      // List (unordered / ordered)
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
          i++;
        }
        out.push(
          <ul key={key++} className="my-2 pl-5 list-disc space-y-1">
            {items.map((item, idx) => (
              <li key={idx}>{renderInline(item, `li${key}-${idx}`)}</li>
            ))}
          </ul>,
        );
        continue;
      }

      // Paragraph — consume consecutive plain lines.
      const para: string[] = [line];
      i++;
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^(#{1,6}\s|```|\s*([-*+]|\d+\.)\s|\s*>)/.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      const content = renderInline(para.join(' '), `p${key}`);
      // Skip paragraphs that were pure HTML noise (badges wrapper, etc.).
      if (content.some((n) => typeof n !== 'string' || n.trim())) {
        out.push(
          <p key={key++} className="my-2 leading-relaxed">
            {content}
          </p>,
        );
      }
    }
    return out;
  }, [source]);

  return <div className="text-[13px] text-forge-text/85">{blocks}</div>;
}

// ── Detail page ──────────────────────────────────────────────────────────

function SidebarSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-5">
      <div className="text-[11px] uppercase tracking-wide text-forge-text/50 mb-2">{title}</div>
      {children}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 py-1 text-[12px]">
      <span className="text-forge-text/50 flex-shrink-0">{label}</span>
      <span className="text-forge-text/85 truncate text-right" title={value}>
        {value}
      </span>
    </div>
  );
}

function ResourceLink({ label, url }: { label: string; url: string }) {
  return (
    <button
      onClick={() => openExternal(url)}
      className="flex items-center gap-1.5 text-[12px] text-forge-accent hover:underline py-0.5"
      title={url}
    >
      <ExternalLink size={11} className="flex-shrink-0" />
      {label}
    </button>
  );
}

export default function ExtensionDetailView({ extension }: { extension: MarketplaceExtension }) {
  const installedExtensions = useStore((s) => s.installedExtensions);
  const extBusy = useStore((s) => s.extBusy);
  const installExtensionById = useStore((s) => s.installExtensionById);
  const uninstallExtension = useStore((s) => s.uninstallExtension);

  const [detail, setDetail] = useState<MarketplaceExtensionDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [iconFailed, setIconFailed] = useState(false);

  const installed = installedExtensions.find(
    (e) => e.id.toLowerCase() === extension.id.toLowerCase(),
  );

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setLoadError(null);
    const load = window.electronAPI?.ext?.detail
      ? window.electronAPI.ext.detail(extension.id)
      : fetchDetailFromRenderer(extension);
    load
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message || 'No se pudo cargar el detalle.');
      });
    return () => {
      cancelled = true;
    };
  }, [extension]);

  const ext = detail ?? extension;
  const updated = formatDate(ext.lastUpdated);
  const initial = (ext.displayName || ext.name || '?').trim().charAt(0).toUpperCase();
  const openVsxUrl = `https://open-vsx.org/extension/${extension.namespace}/${extension.name}`;

  return (
    <div className="w-full h-full overflow-y-auto sidebar-scroll bg-forge-editor select-text">
      <div className="max-w-[900px] mx-auto px-6 py-6">
        {/* ── Header ── */}
        <div className="flex gap-5">
          <div className="w-20 h-20 rounded-lg bg-forge-input border border-forge-border/60 flex items-center justify-center overflow-hidden flex-shrink-0 text-[28px] text-forge-text/60">
            {ext.iconUrl && !iconFailed ? (
              <img
                src={ext.iconUrl}
                alt=""
                className="w-full h-full object-cover"
                onError={() => setIconFailed(true)}
              />
            ) : (
              initial
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-[20px] font-semibold text-forge-text-strong truncate">
                {ext.displayName}
              </h1>
              {ext.verified && <ShieldCheck size={16} className="text-forge-accent flex-shrink-0" />}
              <span className="px-1.5 py-0.5 rounded bg-forge-input text-[10px] text-forge-text/60 border border-forge-border/60">
                v{ext.version}
              </span>
              {detail?.preRelease && (
                <span className="px-1.5 py-0.5 rounded bg-amber-400/10 text-[10px] text-amber-200/90 border border-amber-400/25 uppercase tracking-wide">
                  Pre-release
                </span>
              )}
              {ext.deprecated && (
                <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-400/10 text-[10px] text-red-300 border border-red-400/25 uppercase tracking-wide">
                  <AlertTriangle size={10} />
                  Deprecated
                </span>
              )}
            </div>

            <div className="mt-0.5 text-[12px] text-forge-text/50">
              {extension.namespace}.{extension.name}
            </div>

            <div className="mt-1.5 flex items-center gap-3 text-[11px] text-forge-text/55">
              <span className="flex items-center gap-1">
                <Download size={11} />
                {formatCount(ext.downloadCount)} downloads
              </span>
              {ext.averageRating !== null && (
                <span className="flex items-center gap-1">
                  <Star size={11} />
                  {ext.averageRating.toFixed(1)} ({ext.reviewCount})
                </span>
              )}
              {updated && (
                <span className="flex items-center gap-1">
                  <CalendarDays size={11} />
                  {updated}
                </span>
              )}
            </div>

            {ext.description && (
              <p className="mt-2 text-[13px] leading-snug text-forge-text/75">{ext.description}</p>
            )}

            <div className="mt-3 flex items-center gap-2">
              {installed ? (
                <>
                  <span className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-forge-accent/10 text-forge-accent text-[12px]">
                    <PackageCheck size={13} />
                    Installed
                  </span>
                  <button
                    onClick={() => void uninstallExtension(installed.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-forge-input hover:bg-white/10 text-forge-text text-[12px] transition-colors"
                  >
                    <Trash2 size={13} />
                    Uninstall
                  </button>
                </>
              ) : (
                <button
                  onClick={() => void installExtensionById(extension.id)}
                  disabled={extBusy || ext.deprecated}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-forge-accent/15 hover:bg-forge-accent/25 text-forge-accent text-[12px] transition-colors disabled:opacity-50"
                >
                  {extBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                  Install
                </button>
              )}
              <button
                onClick={() => openExternal(openVsxUrl)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-forge-input hover:bg-white/10 text-forge-text/80 text-[12px] transition-colors"
              >
                <ExternalLink size={13} />
                Open VSX
              </button>
            </div>
          </div>
        </div>

        {/* ── Body: README + metadata sidebar ── */}
        <div className="mt-6 flex gap-8 items-start">
          <div className="min-w-0 flex-1 border-t border-forge-border/40 pt-4">
            {loadError ? (
              <p className="text-[12px] text-red-400/90">{loadError}</p>
            ) : !detail ? (
              <div className="flex items-center gap-2 py-8 text-[12px] text-forge-text/50">
                <Loader2 size={15} className="animate-spin" />
                Cargando detalles…
              </div>
            ) : detail.readme ? (
              <MarkdownView source={detail.readme} />
            ) : (
              <div className="flex flex-col items-center gap-2 py-10 text-forge-text/40">
                <Blocks size={28} />
                <p className="text-[12px]">Esta extensión no incluye README.</p>
              </div>
            )}
          </div>

          <div className="w-[240px] flex-shrink-0 border-t border-forge-border/40 pt-4">
            {(detail?.categories.length ?? 0) > 0 && (
              <SidebarSection title="Categories">
                <div className="flex flex-wrap gap-1.5">
                  {detail!.categories.map((cat) => (
                    <span
                      key={cat}
                      className="px-2 py-0.5 rounded-full bg-forge-input text-[11px] text-forge-text/70 border border-forge-border/50"
                    >
                      {cat}
                    </span>
                  ))}
                </div>
              </SidebarSection>
            )}

            {(detail?.tags.length ?? 0) > 0 && (
              <SidebarSection title="Tags">
                <div className="flex flex-wrap gap-1.5">
                  {detail!.tags.slice(0, 16).map((tag) => (
                    <span
                      key={tag}
                      className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-forge-input text-[11px] text-forge-text/60"
                    >
                      <Tag size={9} />
                      {tag}
                    </span>
                  ))}
                </div>
              </SidebarSection>
            )}

            <SidebarSection title="More Info">
              <InfoRow label="Version" value={ext.version || '—'} />
              {detail?.publishedBy && <InfoRow label="Publisher" value={detail.publishedBy} />}
              {detail?.license && <InfoRow label="License" value={detail.license} />}
              {detail?.engines.vscode && (
                <InfoRow label="VS Code" value={detail.engines.vscode} />
              )}
              {updated && <InfoRow label="Updated" value={updated} />}
            </SidebarSection>

            {(detail?.repository || detail?.homepage || detail?.bugs) && (
              <SidebarSection title="Resources">
                {detail.repository && <ResourceLink label="Repository" url={detail.repository} />}
                {detail.homepage && <ResourceLink label="Homepage" url={detail.homepage} />}
                {detail.bugs && <ResourceLink label="Issues" url={detail.bugs} />}
              </SidebarSection>
            )}

            {installed && <ExtensionRuntimeSection extensionId={installed.id} />}

            {installed && <ExtensionContributionsSection extension={installed} />}

            {installed && <ExtensionSettingsSection extensionId={installed.id} />}

            {installed && installed.trust?.activation !== 'allowed' && (
              <SidebarSection title="Workspace Trust">
                <div className="text-[12px] space-y-1.5">
                  <span className="inline-block px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wide border-amber-400/25 bg-amber-400/10 text-amber-200/90">
                    {installed.trust.activation === 'blocked' ? 'Restricted' : 'Limited'}
                  </span>
                  <div className="text-forge-text/60">
                    {installed.trust.activation === 'blocked'
                      ? 'No se activa: este workspace no es de confianza y la extensión no declara capabilities.untrustedWorkspaces.'
                      : 'Se activa con funcionalidad reducida mientras el workspace no sea de confianza.'}
                  </div>
                  {installed.trust.restrictedConfigurations.length > 0 && (
                    <div className="text-forge-text/45">
                      Settings ignorados: {installed.trust.restrictedConfigurations.join(', ')}
                    </div>
                  )}
                </div>
              </SidebarSection>
            )}

            {installed && (
              <SidebarSection title="Runtime Support">
                <div className="text-[12px] space-y-1.5">
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wide ${
                      installed.compatibility.level === 'full'
                        ? 'border-forge-accent/25 bg-forge-accent/10 text-forge-accent'
                        : installed.compatibility.level === 'partial'
                          ? 'border-amber-400/25 bg-amber-400/10 text-amber-200/90'
                          : 'border-forge-border/70 bg-forge-input/70 text-forge-text/55'
                    }`}
                  >
                    {installed.compatibility.level === 'full'
                      ? 'Declarative'
                      : installed.compatibility.level === 'partial'
                        ? 'Partial'
                        : installed.compatibility.blockers.some(
                              (b) => b.kind === 'requires-extension-host',
                            )
                          ? 'Extension Host required'
                          : 'Metadata only'}
                  </span>
                  {installed.compatibility.supportedContributions.length > 0 && (
                    <div className="text-forge-text/60">
                      Supported: {installed.compatibility.supportedContributions.join(', ')}
                    </div>
                  )}
                  {installed.compatibility.pendingContributions.length > 0 && (
                    <div className="text-forge-text/45">
                      Pending: {installed.compatibility.pendingContributions.join(', ')}
                    </div>
                  )}
                  {installed.contributes.length > 0 && (
                    <div className="text-forge-text/60">
                      Contributes: {installed.contributes.join(', ')}
                    </div>
                  )}
                  {installed.activationEvents.length > 0 && (
                    <div className="text-forge-text/45">
                      {installed.activationEvents.length} activation event
                      {installed.activationEvents.length === 1 ? '' : 's'}
                    </div>
                  )}
                </div>
              </SidebarSection>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
