/**
 * 行程数据包的加解密（issue #34：离线分享）。
 *
 * 方案：bundle JSON → AES-256-GCM（密钥 = scrypt(password, salt)）→ 信封
 * （TripPackageEnvelope：kdf 参数/cipher iv+tag/payload base64）。
 * 零第三方依赖，全部走 node:crypto。
 *
 * - 密码正确性由 GCM 认证标签校验：错密码在解密时抛 WRONG_PASSWORD（不泄露任何明文信息）；
 * - 每次导出随机 salt（16B）+ IV（12B）：同行程同密码两次导出密文不同（防比对）；
 * - scrypt N=16384/r=8/p=1（≈16MB 内存、~50ms/次）：离线暴力破解的单次成本足够高，
 *   在线场景无需限流（导出/导入都是 owner-only 端点）；
 * - 信封 versioned：kdf/cipher 参数随包携带，未来调优不破坏旧包。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { TripBundleSchema, TripPackageEnvelopeSchema, type TripBundle, type TripPackageEnvelope } from "@yarnball/shared";
import { ServiceError } from "./tripService.js";

/** scrypt 参数（信封内携带，解密按包内参数执行以兼容旧包） */
const SCRYPT = { n: 16384, r: 8, p: 1 } as const;
const KEY_LEN = 32; // AES-256

/** 数据包错误（导入端点转 400 给前端友好文案） */
export class TripPackageError extends ServiceError {
  constructor(message: string) {
    super(400, message);
  }
}

/** 导出：bundle → 加密信封。调用方负责先剥离凭证字段（shareToken 等，见 api.ts） */
export function encryptTripBundle(bundle: TripBundle, password: string): TripPackageEnvelope {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, KEY_LEN, { N: SCRYPT.n, r: SCRYPT.r, p: SCRYPT.p });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(bundle), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    format: "yarnball-trip-package",
    version: 1,
    kdf: { algo: "scrypt", salt: salt.toString("hex"), ...SCRYPT },
    cipher: { algo: "aes-256-gcm", iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex") },
    payload: ciphertext.toString("base64"),
  };
}

/**
 * 导入：信封文本 → 解密 → bundle（zod 校验防半损坏数据落库）。
 * 错密码 / 非法文件 / 结构损坏 → TripPackageError(400)，文案面向用户。
 */
export function decryptTripPackage(packageText: string, password: string): TripBundle {
  let envelope: unknown;
  try {
    envelope = JSON.parse(packageText);
  } catch {
    throw new TripPackageError("这不是有效的毛线团数据包文件（JSON 解析失败）");
  }
  const parsed = TripPackageEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new TripPackageError("这不是有效的毛线团数据包文件（格式或版本不识别）");
  }
  const env = parsed.data;
  let key: Buffer;
  try {
    key = scryptSync(password, Buffer.from(env.kdf.salt, "hex"), KEY_LEN, {
      N: env.kdf.n,
      r: env.kdf.r,
      p: env.kdf.p,
    });
  } catch {
    throw new TripPackageError("数据包的密钥参数异常，无法解密");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.cipher.iv, "hex"));
  decipher.setAuthTag(Buffer.from(env.cipher.tag, "hex"));
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(env.payload, "base64")),
      decipher.final(),
    ]);
  } catch {
    // GCM tag 校验失败 = 密码错误（或密文被篡改，对用户而言同一提示且不泄露区别）
    throw new TripPackageError("密码错误，请核对后重试");
  }
  let bundle: unknown;
  try {
    bundle = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new TripPackageError("数据包内容损坏，无法导入");
  }
  const bundleParsed = TripBundleSchema.safeParse(bundle);
  if (!bundleParsed.success) {
    throw new TripPackageError("数据包内的行程数据不完整或版本不兼容，无法导入");
  }
  return bundleParsed.data;
}
