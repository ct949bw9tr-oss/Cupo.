// Arma un archivo .pkpass (boleta de Apple Wallet): un zip con pass.json, imágenes,
// manifest.json (SHA-1 de cada archivo) y signature (firma PKCS#7 del manifest con el
// certificado del Pass Type ID de Apple + el intermedio WWDR de Apple).
// Las librerías se pasan como parámetro para poder probar este mismo archivo fuera de Deno.

export type Signer = { certPem: string; keyPem: string; wwdrPem: string };

// deno-lint-ignore no-explicit-any
export function buildPkpass(files: Record<string, Uint8Array>, signer: Signer, forge: any, zipSync: any): Uint8Array {
  const manifest: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(files)) {
    const md = forge.md.sha1.create();
    md.update(bytesToBinary(bytes));
    manifest[name] = md.digest().toHex();
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(bytesToBinary(manifestBytes));
  const cert = forge.pki.certificateFromPem(signer.certPem);
  p7.addCertificate(cert);
  p7.addCertificate(forge.pki.certificateFromPem(signer.wwdrPem));
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(signer.keyPem),
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign({ detached: true });
  const signature = binaryToBytes(forge.asn1.toDer(p7.toAsn1()).getBytes());

  return zipSync({ ...files, "manifest.json": manifestBytes, signature }, { level: 6 });
}

// Apple publica el intermedio WWDR en formato DER; forge lo necesita en PEM.
// deno-lint-ignore no-explicit-any
export function derToPem(der: Uint8Array, forge: any): string {
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(bytesToBinary(der)));
  return forge.pki.certificateToPem(forge.pki.certificateFromAsn1(asn1));
}

function bytesToBinary(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}
function binaryToBytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
