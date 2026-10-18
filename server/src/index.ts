import 'dotenv/config';
import { createServer } from 'node:http';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const server = createServer(createApp());

server.listen(port, '127.0.0.1', () => {
  console.log(`CLARIO API listening at http://127.0.0.1:${port}`);
});
