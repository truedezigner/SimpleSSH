import keytar from 'keytar'

const SERVICE = 'sftp-sync'

function passwordAccount(id: string) {
  return `conn:${id}:password`
}

function privateKeyAccount(id: string) {
  return `conn:${id}:privateKey`
}

function passphraseAccount(id: string) {
  return `conn:${id}:passphrase`
}

export async function setPassword(id: string, password: string) {
  await keytar.setPassword(SERVICE, passwordAccount(id), password)
}

export async function getPassword(id: string) {
  return keytar.getPassword(SERVICE, passwordAccount(id))
}

export async function deletePassword(id: string) {
  await keytar.deletePassword(SERVICE, passwordAccount(id))
}

export async function setPrivateKey(id: string, privateKey: string) {
  await keytar.setPassword(SERVICE, privateKeyAccount(id), privateKey)
}

export async function getPrivateKey(id: string) {
  return keytar.getPassword(SERVICE, privateKeyAccount(id))
}

export async function deletePrivateKey(id: string) {
  await keytar.deletePassword(SERVICE, privateKeyAccount(id))
}

export async function setPassphrase(id: string, passphrase: string) {
  await keytar.setPassword(SERVICE, passphraseAccount(id), passphrase)
}

export async function getPassphrase(id: string) {
  return keytar.getPassword(SERVICE, passphraseAccount(id))
}

export async function deletePassphrase(id: string) {
  await keytar.deletePassword(SERVICE, passphraseAccount(id))
}
