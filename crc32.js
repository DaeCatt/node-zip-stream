"use strict";

const CRCTable = new Uint32Array(256);
for (let i = 0; i < 256; ++i) {
	CRCTable[i] = i;
	for (let z = 8; z > 0; --z)
		CRCTable[i] =
			CRCTable[i] & 1
				? (CRCTable[i] >>> 1) ^ 0xedb88320
				: CRCTable[i] >>> 1;
}

/**
 * @param {Uint8Array} buffer
 * @param {number} seed
 */
const crc32 = (buffer, seed = 0xffffffff) => {
	let crc32 = seed;
	for (let i = 0; i < buffer.length; ++i) {
		const lookupIndex = (crc32 ^ buffer[i]) & 0xff;
		crc32 = (crc32 >>> 8) ^ CRCTable[lookupIndex];
	}

	return ~crc32 >>> 0;
};

module.exports = crc32;
