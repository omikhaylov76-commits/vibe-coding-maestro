import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packageRoot } from '../paths.js';
import { error } from './types.js';
import type { DoctorFinding } from './types.js';

interface CapabilityRecord {
  status: 'keep' | 'adapt' | 'reject';
  ownerPath: string | null;
  contractId: string | null;
}

interface CapabilityLedger {
  schemaVersion: 1;
  capabilities: CapabilityRecord[];
}

export function isCapabilityLedger(value: unknown): value is CapabilityLedger {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { schemaVersion?: unknown; capabilities?: unknown };
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.capabilities) || candidate.capabilities.length === 0) return false;
  return candidate.capabilities.every((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const record = item as Partial<CapabilityRecord>;
    if (record.status === 'reject') return record.ownerPath === null && record.contractId === null;
    if (record.status === 'keep' || record.status === 'adapt') {
      return typeof record.ownerPath === 'string'
        && /^protocols\/.+\.md$/.test(record.ownerPath)
        && typeof record.contractId === 'string'
        && /^VCM-[A-Z0-9-]+$/.test(record.contractId);
    }
    return false;
  });
}

/**
 * Проверяет semantic anchors по единственному package source of truth — capability ledger.
 * Checksums обнаруживают любой drift, а этот check даёт точную диагностику потери контракта.
 */
export async function checkProtocols(root: string, findings: DoctorFinding[]): Promise<void> {
  let ledger: CapabilityLedger;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(packageRoot(), 'registry/capabilities.v1.json'), 'utf8'));
    if (!isCapabilityLedger(parsed)) throw new Error('неверная структура capability ledger');
    ledger = parsed;
  } catch (cause) {
    findings.push(error('protocol-registry-invalid', `Capability registry пакета повреждён: ${cause instanceof Error ? cause.message : String(cause)}`));
    return;
  }

  const cache = new Map<string, string | null>();
  for (const capability of ledger.capabilities) {
    if (capability.status === 'reject' || capability.ownerPath === null || capability.contractId === null) continue;
    if (!cache.has(capability.ownerPath)) {
      try {
        cache.set(capability.ownerPath, await readFile(join(root, capability.ownerPath), 'utf8'));
      } catch {
        cache.set(capability.ownerPath, null);
      }
    }
    const text = cache.get(capability.ownerPath);
    const anchor = `<a id="${capability.contractId}"></a>`;
    if (text !== null && text !== undefined && !text.includes(anchor)) {
      findings.push(error('protocol-contract-missing', `Canonical contract anchor отсутствует: ${capability.contractId}.`, capability.ownerPath));
    }
  }
}
