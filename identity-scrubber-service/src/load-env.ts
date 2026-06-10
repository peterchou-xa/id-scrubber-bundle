import * as dotenv from 'dotenv';
import * as path from 'path';

// Load the env file matching NODE_ENV (default: development).
//   npm run start:dev  -> NODE_ENV=development -> .env.dev
//   pm2 (ecosystem)    -> NODE_ENV=production  -> .env.prod
const envFile = process.env.NODE_ENV === 'production' ? '.env.prod' : '.env.dev';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });
