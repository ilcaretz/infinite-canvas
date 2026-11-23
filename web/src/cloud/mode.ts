/** Cloud mode = the backend is the Cloudflare Worker: the uploader's browser does the media work the Node server used to do. */

export interface CloudFlags {
  storage?: string;
  cloud?: boolean;
  mode?: string;
}

/** True when /api/config says the backend is the cloud Worker (`mode: 'cloud'`, or `storage: 's3'` together with `cloud: true`). */
export function isCloudConfig(cfg: CloudFlags | null | undefined): boolean {
  if (!cfg) return false;
  return cfg.mode === 'cloud' || (cfg.storage === 's3' && cfg.cloud === true);
}
