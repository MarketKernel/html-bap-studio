/**
 * Entry point: the studio's frame takes the page. `window.bap` is the shell,
 * for the browser tests and for the curious in the console.
 */
import { Shell } from './shell';
import { runContract } from '../core/contract';

const shell = new Shell(document.getElementById('app')!);
Object.assign(window, { bap: shell, bapTools: { runContract } });
void shell.start();
