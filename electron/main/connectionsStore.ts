import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

export type VerifyMode = 'sha256-remote' | 'download-back'
export type AuthType = 'password' | 'key'
export type SyncMode = 'manual' | 'upload' | 'live'

export interface Connection {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  keyName: string
  remoteRoot: string
  localRoot: string
  verifyMode: VerifyMode
  syncMode: SyncMode
  liveSyncIntervalSec: number
  hostingProvider: string
  codeCommand: string
}

export interface ConnectionInput extends Omit<Connection, 'id'> {
  id?: string
}

const CONNECTIONS_FILE = 'connections.json'

function connectionsPath() {
  return path.join(app.getPath('userData'), CONNECTIONS_FILE)
}

async function readConnections(): Promise<Connection[]> {
  try {
    const raw = await fs.readFile(connectionsPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.map((item) => ({
        keyName: '',
        authType: 'password' as AuthType,
        syncMode: 'manual' as SyncMode,
        liveSyncIntervalSec: 5,
        hostingProvider: 'none',
        ...item,
      })) as Connection[]
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code !== 'ENOENT') throw error
  }
  return []
}

async function writeConnections(connections: Connection[]) {
  const payload = JSON.stringify(connections, null, 2)
  await fs.mkdir(path.dirname(connectionsPath()), { recursive: true })
  await fs.writeFile(connectionsPath(), payload, 'utf8')
}

export async function listConnections() {
  return readConnections()
}

export async function getConnection(id: string) {
  const connections = await readConnections()
  return connections.find((connection) => connection.id === id) ?? null
}

export async function upsertConnection(input: ConnectionInput) {
  const connections = await readConnections()
  const id = input.id ?? crypto.randomUUID()
  const next = {
    keyName: '',
    authType: 'password' as AuthType,
    syncMode: 'manual' as SyncMode,
    liveSyncIntervalSec: 5,
    hostingProvider: 'none',
    ...input,
    id,
  }
  const index = connections.findIndex((item) => item.id === id)
  if (index >= 0) {
    connections[index] = next
  } else {
    connections.push(next)
  }
  await writeConnections(connections)
  return next
}

export async function deleteConnection(id: string) {
  const connections = await readConnections()
  const filtered = connections.filter((connection) => connection.id !== id)
  await writeConnections(filtered)
  return filtered
}
