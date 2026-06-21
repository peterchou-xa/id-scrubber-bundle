import * as dotenv from 'dotenv';
import * as path from 'path';

// Load the env file matching NODE_ENV (default: development).
//   npm run start:dev  -> NODE_ENV=development -> .env.dev
//   pm2 (ecosystem)    -> NODE_ENV=production  -> .env.prod
const envFile = process.env.NODE_ENV === 'production' ? '.env.prod' : '.env.dev';
// Resolve relative to this file (dist/load-env.js -> service root), not
// process.cwd(), which under pm2 is the directory pm2 was started from and may
// not contain the .env files — dotenv fails silently when the path is wrong.
dotenv.config({ path: path.resolve(__dirname, '..', envFile) });
