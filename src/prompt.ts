import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/** Asks one question on the terminal. With hidden=true the typed answer is not echoed (passwords, codes). */
export function promptLine(question: string, hidden: boolean): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.reject(new Error('Interactive input required; run this command in a terminal'));
  }
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
    muted = hidden;
  });
}

/** Reads all of stdin (used by hooks). Returns '' when stdin is a terminal so the CLI never hangs. */
export async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
