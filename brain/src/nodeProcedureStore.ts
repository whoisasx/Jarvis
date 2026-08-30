import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import type {LearnedProcedure, ProcedureStore} from './procedureMemory.js';

export function createNodeProcedureStore(
  filePath = process.env.JARVIS_MEMORY_PATH || resolve(process.cwd(), 'data', 'procedures.jsonl'),
): ProcedureStore {
  return {
    load() {
      if (!existsSync(filePath)) return [];
      const items: LearnedProcedure[] = [];
      for (const line of readFileSync(filePath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line) as LearnedProcedure;
          if (item.id && item.goal) items.push(item);
        } catch {
          // skip corrupt line
        }
      }
      return items;
    },
    save(procedures) {
      mkdirSync(dirname(filePath), {recursive: true});
      const body = procedures.map(item => JSON.stringify(item)).join('\n') + (procedures.length ? '\n' : '');
      writeFileSync(filePath, body);
    },
  };
}