import { api, type AppConfig, type OpenInComfyResult } from './api';
import { toast } from './Toast';

/** Workflow name as the server saves it (file name without extension). Mirrors server safeWorkflowName loosely: display only. */
export function workflowLabel(name: string): string {
  return name.replace(/\.[^./\\]*$/, '') || 'workflow';
}

/** Toast text for the outcome of "Open in ComfyUI" (pure; unit-tested). */
export function openResultText(res: OpenInComfyResult, copied: boolean): string {
  if (res.saved) {
    const n = res.path.replace(/^Board\//, '').replace(/\.json$/, '');
    return `Workflow saved in ComfyUI → Workflows › Board › ${n}` + (copied ? ' (also copied — Ctrl+V on the ComfyUI canvas)' : '');
  }
  return "ComfyUI isn't running — workflow " + (copied ? 'copied to clipboard' : 'could not be copied (use Download .json)');
}

let configP: Promise<AppConfig> | null = null;
/** /api/config, fetched once (falls back to safe defaults when the server does not answer). */
export function getConfig(): Promise<AppConfig> {
  configP ??= api.config().catch(() => {
    configP = null; // do not remember a failed fetch (the upload path depends on `storage`)
    return { comfyUrl: 'http://127.0.0.1:8188', canReveal: false, storage: 'local' as const, authRequired: false };
  });
  return configP;
}

async function copyToClipboard(textP: Promise<string>): Promise<boolean> {
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      // Handing over the promise keeps the user gesture valid while the workflow is still loading.
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': textP.then((t) => new Blob([t], { type: 'text/plain' })) })]);
      return true;
    }
    await navigator.clipboard.writeText(await textP);
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(await textP);
      return true;
    } catch {
      return false;
    }
  }
}

/** Cloud mode: no ComfyUI on this machine to launch, so only put the workflow on the clipboard. */
export async function copyWorkflow(mediaId: string): Promise<void> {
  const textP = api.workflowText(mediaId);
  textP.catch(() => undefined);
  const copied = await copyToClipboard(textP);
  try {
    await textP;
  } catch (e) {
    toast((e as Error).message);
    return;
  }
  toast(copied ? 'Workflow copied — Ctrl+V on the ComfyUI canvas' : 'Could not copy the workflow to the clipboard');
}

/** Right-click → Open in ComfyUI: save the workflow into ComfyUI (Workflows › Board), copy it, open ComfyUI. Call from a click handler. */
export async function openInComfy(mediaId: string, itemName: string): Promise<void> {
  const cfgP = getConfig();
  const textP = api.workflowText(mediaId);
  textP.catch(() => undefined); // handled below; keeps the unhandled-rejection logger quiet
  const savedP = api.openInComfy(mediaId).catch((e: Error): OpenInComfyResult => ({ saved: false, reason: e.message }));
  const copiedP = copyToClipboard(textP);
  let text: string;
  try {
    text = await textP;
  } catch (e) {
    toast((e as Error).message);
    return;
  }
  const [res, copied, cfg] = await Promise.all([savedP, copiedP, cfgP]);
  if (res.saved) {
    window.open(cfg.comfyUrl, '_blank', 'noopener');
    toast(openResultText(res, copied));
  } else {
    const href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    toast(openResultText(res, copied), { link: { label: 'Download .json', href, download: `${workflowLabel(itemName)}.json` } });
  }
}
