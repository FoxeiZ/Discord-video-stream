import { crypto_secretbox_easy } from "libsodium-wrappers";
import { MediaUdp } from "../voice/MediaUdp";

export const max_int16bit = 2 ** 16;
export const max_int32bit = 2 ** 32;

const ntpEpoch = new Date("Jan 01 1900 GMT").getTime();

export class BaseMediaPacketizer {
    private _payloadType: number;
    private _mtu: number;
    private _sequence: number;
    private _timestamp: number;
    private _totalBytes: number;
    private _prevTotalPackets: number;
    private _lastPacketTime: number;
    private _mediaUdp: MediaUdp;
    private _extensionEnabled: boolean;

    constructor(connection: MediaUdp, payloadType: number, extensionEnabled = false) {
        this._mediaUdp = connection;
        this._payloadType = payloadType;
        this._sequence = 0;
        this._timestamp = 0;
        this._totalBytes = 0;
        this._prevTotalPackets = 0;
        this._mtu = 1200;
        this._extensionEnabled = extensionEnabled;
    }

    public sendFrame(frame:any): void {
        // override this
        this._lastPacketTime = Date.now();
    }

    public onFrameSent(bytesSent: number, ssrc: number): void {
        this._totalBytes = (this._totalBytes + bytesSent) % max_int32bit;

        let packetCount = this._sequence;
        if (this._prevTotalPackets > packetCount)
            // We have rolled over, add 2^32 to the packet count
            packetCount += max_int32bit;
        
        // Send a RTCP Sender Report every 2^7 packets
        // Number chosen is completely arbitrary
        const interval = 2 ** 7;

        // Not using modulo here, since the number of packet sent might not be
        // exactly a multiple of 2^7
        if (Math.floor(packetCount / interval) - Math.floor(this._prevTotalPackets / interval) > 0)
        {
            const senderReport = this.makeRtcpSenderReport(ssrc);
            this._mediaUdp.sendPacket(senderReport);
            this._prevTotalPackets = this._sequence;
        }
    }

    /**
     * Partitions a buffer into chunks of length this.mtu
     * @param data buffer to be partitioned
     * @returns array of chunks
     */
    public partitionDataMTUSizedChunks(data: any): any[] {
        let i = 0;
        let len = data.length;
    
        const out = [];
    
        while (len > 0) {
            const size = Math.min(len, this._mtu);
            out.push(data.slice(i, i + size));
            len -= size;
            i += size;
        }
    
        return out;
    }

    public getNewSequence(): number {
        this._sequence = (this._sequence + 1) % max_int32bit;
        return this._sequence % max_int16bit;
    }

    public incrementTimestamp(incrementBy: number): void {
        this._timestamp = (this._timestamp + incrementBy) % max_int32bit;
    }

    public makeRtpHeader(ssrc: number, isLastPacket: boolean = true): Buffer {
        const packetHeader = Buffer.alloc(12);
    
        packetHeader[0] = 2 << 6 | ((this._extensionEnabled ? 1 : 0) << 4); // set version and flags
        packetHeader[1] = this._payloadType; // set packet payload
        if (isLastPacket)
            packetHeader[1] |= 0b10000000; // mark M bit if last frame
    
        packetHeader.writeUIntBE(this.getNewSequence(), 2, 2);
        packetHeader.writeUIntBE(this._timestamp, 4, 4);
        packetHeader.writeUIntBE(ssrc, 8, 4);
        return packetHeader;
    }

    public makeRtcpSenderReport(ssrc: number): Buffer {
        const packetHeader = Buffer.allocUnsafe(8);

        packetHeader[0] = 0x80; // RFC1889 v2, no padding, no reception report count
        packetHeader[1] = 0xc8; // Type: Sender Report (200)

        // Packet length (always 0x06 for some reason)
        packetHeader[2] = 0x00;
        packetHeader[3] = 0x06;
        packetHeader.writeUInt32BE(ssrc, 4);

        const senderReport = Buffer.allocUnsafe(20);

        // Convert from floating point to 32.32 fixed point
        // Convert each part separately to reduce precision loss
        const ntpTimestamp = this._lastPacketTime - ntpEpoch;
        const ntpTimestampMsw = Math.floor(ntpTimestamp);
        const ntpTimestampLsw = Math.round((ntpTimestamp - ntpTimestampMsw) * max_int32bit);

        senderReport.writeUInt32BE(ntpTimestampMsw, 0);
        senderReport.writeUInt32BE(ntpTimestampLsw, 4);
        senderReport.writeUInt32BE(this._timestamp, 8);
        senderReport.writeUInt32BE(this._sequence, 12);
        senderReport.writeUInt32BE(this._totalBytes, 16);

        const nonceBuffer = this._mediaUdp.getNewNonceBuffer();
        return Buffer.concat([
            packetHeader,
            crypto_secretbox_easy(senderReport, nonceBuffer, this._mediaUdp.mediaConnection.secretkey),
            nonceBuffer.subarray(0, 4)
        ]);
    }

    /**
     * Creates a single extension of type playout-delay
     * Discord seems to send this extension on every video packet 
     * @see https://webrtc.googlesource.com/src/+/refs/heads/main/docs/native-code/rtp-hdrext/playout-delay 
     * @returns playout-delay extension @type Buffer
     */
    public createHeaderExtension(): Buffer {
        const extensions = [{ id: 5, len: 2, val: 0}];

        /**
         *  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
            +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
            |      defined by profile       |           length              |
            +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
        */
        const profile = Buffer.alloc(4);
        profile[0] = 0xBE;
        profile[1] = 0xDE;
        profile.writeInt16BE(extensions.length, 2); // extension count
        
        const extensionsData = [];
        for(let ext of extensions){
            /**
             * EXTENSION DATA - each extension payload is 32 bits
             */
            const data = Buffer.alloc(4);

            /**
             *  0 1 2 3 4 5 6 7
                +-+-+-+-+-+-+-+-+
                |  ID   |  len  |
                +-+-+-+-+-+-+-+-+

            where len = actual length - 1
            */
            data[0] = (ext.id & 0b00001111) << 4;
            data[0] |= ((ext.len - 1) & 0b00001111);

            /**  Specific to type playout-delay
             *  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4
                +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
                |       MIN delay       |       MAX delay       |
                +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
            */
            data.writeUIntBE(ext.val, 1, 2); // not quite but its 0 anyway

            extensionsData.push(data);
        }

        return Buffer.concat([profile, ...extensionsData])
    }

    // encrypts all data that is not in rtp header.
    // rtp header extensions and payload headers are also encrypted
    public encryptData(message: string | Uint8Array, nonceBuffer: Buffer) : Uint8Array {
        return crypto_secretbox_easy(message, nonceBuffer, this._mediaUdp.mediaConnection.secretkey);
    }

    public get mediaUdp(): MediaUdp {
        return this._mediaUdp;
    }

    public get mtu(): number {
        return this._mtu;
    }
}