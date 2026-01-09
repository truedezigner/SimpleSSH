import { Client } from 'ssh2'

export interface TestConnectionInput {
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  password?: string
  privateKey?: string
  passphrase?: string
  remoteRoot: string
}

export interface TestConnectionResult {
  ok: boolean
  message: string
}

export function testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
  return new Promise((resolve) => {
    if (input.authType === 'password' && !input.password) {
      resolve({ ok: false, message: 'Missing password.' })
      return
    }
    if (input.authType === 'key' && !input.privateKey) {
      resolve({ ok: false, message: 'Missing private key.' })
      return
    }

    const client = new Client()
    const cleanup = () => {
      client.removeAllListeners()
      client.end()
    }

    const fail = (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Connection failed.'
      cleanup()
      resolve({ ok: false, message })
    }

    client
      .on('ready', () => {
        client.sftp((err, sftp) => {
          if (err) return fail(err)
          const target = input.remoteRoot || '.'
          sftp.readdir(target, (readErr) => {
            if (readErr) return fail(readErr)
            cleanup()
            resolve({ ok: true, message: 'Connection OK.' })
          })
        })
      })
      .on('error', fail)
      .connect({
        host: input.host,
        port: input.port,
        username: input.username,
        password: input.authType === 'password' ? input.password : undefined,
        privateKey: input.authType === 'key' ? input.privateKey : undefined,
        passphrase: input.authType === 'key' ? input.passphrase : undefined,
        readyTimeout: 10000,
      })
  })
}
