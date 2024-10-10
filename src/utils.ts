export function normalizeVideoCodec(codec: string): "H264" | "H265" | "VP8" | "VP9" | "AV1" | "h264_mediacodec" | "hevc_mediacodec"
{
    if (codec === "h264_mediacodec" || codec === "hevc_mediacodec")
        return codec;
    if (/H\.?264|AVC/i.test(codec))
        return "H264";
    if (/H\.?265|HEVC/i.test(codec))
        return "H265";
    if (/VP(8|9)/i.test(codec))
        return codec.toUpperCase() as "VP8" | "VP9";
    if (/AV1/i.test(codec))
        return "AV1";
    throw new Error(`Unknown codec: ${codec}`);
}
