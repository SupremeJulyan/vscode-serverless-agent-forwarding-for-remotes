import { createCipheriv, createDecipheriv, createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';

const prefix = 'enc:v1:';
const iterations = 600_000;

function derive(password: Buffer, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    pbkdf2(password, salt, iterations, length, 'sha256', (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

async function authenticationKey(password: string, salt: Buffer): Promise<Buffer> {
  return derive(Buffer.concat([Buffer.from('wsl-vpn-hmac\0'), Buffer.from(password)]), salt, 32);
}

export function isEncryptedPassword(value: string): boolean {
  return value.startsWith(prefix);
}

export async function encryptPassword(value: string, password: string): Promise<string> {
  const salt = randomBytes(8);
  const keyAndIv = await derive(Buffer.from(password), salt, 48);
  const cipher = createCipheriv('aes-256-cbc', keyAndIv.subarray(0, 32), keyAndIv.subarray(32));
  const ciphertext = Buffer.concat([
    Buffer.from('Salted__'), salt, cipher.update(Buffer.from(value)), cipher.final()
  ]);
  const tag = createHmac('sha256', await authenticationKey(password, salt)).update(ciphertext).digest();
  return prefix + Buffer.concat([ciphertext, tag]).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_');
}

export async function decryptPassword(value: string, password: string): Promise<string> {
  try {
    if (!isEncryptedPassword(value)) throw new Error('Password is not encrypted');
    const raw = Buffer.from(value.slice(prefix.length), 'base64url');
    const ciphertext = raw.subarray(0, -32);
    const tag = raw.subarray(-32);
    if (ciphertext.length < 32 || ciphertext.subarray(0, 8).toString() !== 'Salted__' || tag.length !== 32) {
      throw new Error('Invalid encrypted password');
    }
    const salt = ciphertext.subarray(8, 16);
    const expected = createHmac('sha256', await authenticationKey(password, salt)).update(ciphertext).digest();
    if (!timingSafeEqual(tag, expected)) throw new Error('Invalid encrypted password');
    const keyAndIv = await derive(Buffer.from(password), salt, 48);
    const decipher = createDecipheriv('aes-256-cbc', keyAndIv.subarray(0, 32), keyAndIv.subarray(32));
    return Buffer.concat([decipher.update(ciphertext.subarray(16)), decipher.final()]).toString();
  } catch {
    throw new Error('配置密码解密失败：主口令错误或密文已损坏');
  }
}
