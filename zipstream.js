"use strict";

const stream = require("stream");
const zlib = require("zlib");
const crc32 = require("./crc32.js");

const FILENAME_RE = /^[^\\?%*:|"<>]+(?:\/[^\\?%*:|"<>]+)*$/;
const DEFLATE = 0x08;
const COMPRESSION_FLAGS = (1 << 3) | (1 << 11);

/**
 * @param {stream.Writable} target
 * @param {Buffer} chunk
 * @return {Promise<void>}
 */
const promiseWrite = (target, chunk) =>
	new Promise((resolve, reject) => {
		target.write(chunk, (error) => (error ? reject(error) : resolve()));
	});

/**
 * Usage
 * ```
 * const fs = require("fs");
 * const ZIPStream = require("node-zip-stream");
 *
 * const zip = new ZIPStream();
 * // Point the zip stream somewhere
 * zip.pipe(fs.createWriteStream("file.zip"));
 *
 * // Add a file, resolves when stream has ended
 * await zip.addFile("filename.txt", fs.createReadStream("file.txt"));
 *
 * // Finish the zip file, resolves when flushed
 * await zip.flush();
 * ```
 */
class ZIPStream extends stream.Transform {
	bytes = 0;
	records = 0;
	cd = Buffer.alloc(0);

	_transform(chunk, encoding, callback) {
		if (Buffer.isBuffer(chunk)) this.bytes += chunk.byteLength;
		callback(null, chunk);
	}

	/**
	 * @param {string} filename
	 * @param {AsyncIterable<Uint8Array>} fileStream
	 */
	async addFile(filename, fileStream) {
		if (!FILENAME_RE.test(filename)) throw new Error("Invalid filename.");
		const start = this.bytes;
		this.records++;

		// Create local file header
		const filenameBuf = Buffer.from(filename, "utf-8");
		const lfh = Buffer.alloc(30 + filenameBuf.byteLength);
		lfh.writeUInt32LE(0x04034b50, 0);
		lfh.writeUint16LE(20, 4);
		// Data descriptor flag is set here since we don't have the original file yet.
		lfh.writeUint16LE(COMPRESSION_FLAGS, 6);
		lfh.writeUint16LE(DEFLATE, 8);
		lfh.writeUint16LE(filenameBuf.byteLength, 26);
		filenameBuf.copy(lfh, 30);

		await promiseWrite(this, lfh);

		// Determine CRC-32, compressed file size, and original file size
		let fileCRC32 = 0xffffffff;
		let compressedBytes = 0;
		let origBytes = 0;

		const compressor = zlib.createDeflateRaw();
		const filePromise = async () => {
			for await (const chunk of fileStream) {
				origBytes += chunk.byteLength;
				fileCRC32 = crc32(chunk, fileCRC32);
				compressor.write(chunk);
			}
			compressor.end();
		};

		const compressorPromise = async () => {
			for await (const chunk of compressor) {
				compressedBytes += chunk.byteLength;
				await promiseWrite(this, chunk);
			}
		};

		await Promise.all([compressorPromise(), filePromise()]);

		// Create data descriptor
		const dd = Buffer.alloc(12);
		dd.writeUint32LE(fileCRC32, 0);
		dd.writeUint32LE(compressedBytes, 4);
		dd.writeUint32LE(origBytes, 8);

		await promiseWrite(this, dd);

		// Create central directory file header
		const cdfh = Buffer.alloc(46 + filenameBuf.byteLength);
		cdfh.writeUint32LE(0x02014b50, 0);
		cdfh.writeUint16LE(20, 6);
		cdfh.writeUint16LE(COMPRESSION_FLAGS, 8);
		cdfh.writeUint16LE(DEFLATE, 10);
		cdfh.writeUint32LE(fileCRC32, 16);
		cdfh.writeUint32LE(compressedBytes, 20);
		cdfh.writeUint32LE(origBytes, 24);
		cdfh.writeUint16LE(filenameBuf.byteLength, 28);
		cdfh.writeUint32LE(start, 42);
		filenameBuf.copy(cdfh, 46);
		this.cd = Buffer.concat([this.cd, cdfh]);
	}

	/**
	 * Mark end of zip file and flush central directory
	 */
	async flush() {
		const start = this.bytes;
		await promiseWrite(this, this.cd);

		const eocd = Buffer.alloc(22);
		eocd.writeUint32LE(0x06054b50, 0);
		eocd.writeUint16LE(this.records, 10);
		eocd.writeUint16LE(this.cd.byteLength, 12);
		eocd.writeUint32LE(start, 16);

		await promiseWrite(this, eocd);
		await this.end();
	}
}

module.exports = ZIPStream;
