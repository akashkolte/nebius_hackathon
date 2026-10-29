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
  demo: { enabled: boolean; maxTasksPerHour: number; maxConcurrent: number };
  nebius: {
    baseUrl: string;
    apiKey: string;
    routerModel: string;
    defaultAgentModel: string;
  };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const homeDir = env.DISPATCH_HOME_DIR || os.homedir();
  return {
    port: Number(env.PORT || 4378),
    // Listen on this machine only unless DISPATCH_LAN=1; remote access goes through a tunnel you choose.
    host: env.HOST || (env.DISPATCH_LAN === '1' ? '0.0.0.0' : '127.0.0.1'),
    dataDir: env.DISPATCH_DATA_DIR || path.join(rootDir, '.dispatch-data'),
    publicDir: path.join(rootDir, 'public'),
    workspaceRoot: env.DISPATCH_WORKSPACES || path.join(homeDir, 'Dispatch Workspaces'),
    homeDir,
    // DISPATCH_CLI=0 runs Nebius-only: desktop CLIs are neither probed nor offered.
    cliHarnesses: env.DISPATCH_CLI !== '0',
    // DISPATCH_DEMO=1 is for a shared public instance: commands always need approval and usage is capped.
    demo: {
      enabled: env.DISPATCH_DEMO === '1',
      maxTasksPerHour: Number(env.DISPATCH_MAX_TASKS_PER_HOUR || 30),
      maxConcurrent: Number(env.DISPATCH_MAX_CONCURRENT || 3),
    },
    nebius: {
      baseUrl: (env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1').replace(/\/+$/, ''),
      apiKey: env.NEBIUS_API_KEY || env.NEBIUS_TEMP_API_KEY || '',
      routerModel: env.NEBIUS_ROUTER_MODEL || '',
      defaultAgentModel: env.NEBIUS_AGENT_MODEL || '',
    },
  };
}
