//! A minimal Ogg Opus writer (RFC 7845). Pages are appended and never
//! rewritten, so whatever is on disk is a valid prefix to upload.

use anyhow::Result;
use ogg::writing::{PacketWriteEndInfo, PacketWriter};
use std::fs::File;
use std::io::Write;
use std::path::Path;

const PAGE_EVERY: u32 = 50; // packets; one page a second

pub struct OggOpusWriter {
    ogg: PacketWriter<'static, File>,
    enc: opus::Encoder,
    serial: u32,
    granule: u64,
    in_page: u32,
}

impl OggOpusWriter {
    pub fn create(path: &Path) -> Result<Self> {
        let file = File::create(path)?;
        let mut enc = opus::Encoder::new(super::RATE, opus::Channels::Stereo, opus::Application::Voip)?;
        // 24 kbit/s a channel: clear speech, about 21 MB an hour.
        enc.set_bitrate(opus::Bitrate::Bits(48_000))?;
        let pre_skip = enc.get_lookahead()? as u16;
        let serial: u32 = rand_serial();
        let mut ogg = PacketWriter::new(file);

        let mut head = Vec::with_capacity(19);
        head.extend_from_slice(b"OpusHead");
        head.push(1); // version
        head.push(2); // channels
        head.extend_from_slice(&pre_skip.to_le_bytes());
        head.extend_from_slice(&super::RATE.to_le_bytes());
        head.extend_from_slice(&0i16.to_le_bytes()); // output gain
        head.push(0); // mapping family: mono/stereo
        ogg.write_packet(head, serial, PacketWriteEndInfo::EndPage, 0)?;

        let vendor = b"Debrief Recorder";
        let mut tags = Vec::new();
        tags.extend_from_slice(b"OpusTags");
        tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
        tags.extend_from_slice(vendor);
        tags.extend_from_slice(&0u32.to_le_bytes());
        ogg.write_packet(tags, serial, PacketWriteEndInfo::EndPage, 0)?;
        ogg.inner_mut().flush()?;

        Ok(Self { ogg, enc, serial, granule: 0, in_page: 0 })
    }

    /// One 20 ms frame: 960 interleaved stereo samples.
    pub fn write_frame(&mut self, pcm: &[f32]) -> Result<()> {
        let packet = self.enc.encode_vec_float(pcm, 4000)?;
        self.granule += (pcm.len() / 2) as u64;
        self.in_page += 1;
        let end = if self.in_page >= PAGE_EVERY {
            self.in_page = 0;
            PacketWriteEndInfo::EndPage
        } else {
            PacketWriteEndInfo::NormalPacket
        };
        self.ogg.write_packet(packet, self.serial, end, self.granule)?;
        if end == PacketWriteEndInfo::EndPage {
            self.ogg.inner_mut().flush()?;
        }
        Ok(())
    }

    /// Ends the stream with a last frame of silence.
    pub fn finish(mut self) -> Result<()> {
        let silence = vec![0f32; 960 * 2];
        let packet = self.enc.encode_vec_float(&silence, 4000)?;
        self.granule += 960;
        self.ogg.write_packet(packet, self.serial, PacketWriteEndInfo::EndStream, self.granule)?;
        let file = self.ogg.into_inner();
        file.sync_all()?;
        Ok(())
    }
}

fn rand_serial() -> u32 {
    let u = uuid::Uuid::new_v4();
    u32::from_le_bytes(u.as_bytes()[..4].try_into().unwrap())
}
