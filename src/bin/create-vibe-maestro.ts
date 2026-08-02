#!/usr/bin/env node
import { runCreateCli } from '../cli/create.js';

process.exitCode = await runCreateCli(process.argv.slice(2));
