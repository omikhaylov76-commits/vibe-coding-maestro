#!/usr/bin/env node
import { runMaestroCli } from '../cli/maestro.js';

process.exitCode = await runMaestroCli(process.argv.slice(2));
