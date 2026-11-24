// Replays one solo run off the main thread, so a long run never stalls a race.
import { parentPort, workerData } from 'node:worker_threads';
import { judgeRun } from './run-check.mjs';

parentPort.postMessage(judgeRun(workerData));
