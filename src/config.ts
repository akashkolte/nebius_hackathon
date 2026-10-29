import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export type Config = {
  port: number;
  host: string;
  dataDir: string;
  publicDir: string;
  workspaceRoot: string;
  homeDir: string;
  cliHarnesses: boolean;
  nebius: {
    baseUrl: string;
    apiKey: string;
    routerModel: string;
    defaultAgentModel: string;
  };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const homeDir = env.SHED_HOME_DIR || os.homedir();
  return {
    port: Number(env.PORT || 4378),
    // Listen on this machine only unless SHED_LAN=1; remote access goes through a tunnel you choose.
    host: env.HOST || (env.SHED_LAN === '1' ? '0.0.0.0' : '127.0.0.1'),
    dataDir: env.SHED_DATA_DIR || path.join(rootDir, '.shed-data'),
    publicDir: path.join(rootDir, 'public'),
    workspaceRoot: env.SHED_WORKSPACES || path.join(homeDir, 'Shed Workspaces'),
    homeDir,
    // SHED_CLI=0 runs Nebius-only: desktop CLIs are neither probed nor offered.
    cliHarnesses: env.SHED_CLI !== '0',
    nebius: {
      baseUrl: (env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1').replace(/\/+$/, ''),
      apiKey: env.NEBIUS_API_KEY || env.NEBIUS_TEMP_API_KEY || '',
      routerModel: env.NEBIUS_ROUTER_MODEL || '',
      defaultAgentModel: env.NEBIUS_AGENT_MODEL || '',
    },
  };
}
