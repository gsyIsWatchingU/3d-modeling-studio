const fs = require('fs');
const sharp = require('sharp');

async function createReferenceBoard(imagePaths, outputPath) {
    if (!Array.isArray(imagePaths) || imagePaths.length === 0) throw new Error('缺少参考图');
    if (imagePaths.length === 1) return imagePaths[0];

    const tile = 512;
    const gap = 16;
    const columns = imagePaths.length <= 2 ? imagePaths.length : imagePaths.length <= 4 ? 2 : 3;
    const rows = Math.ceil(imagePaths.length / columns);
    const width = columns * tile + (columns + 1) * gap;
    const height = rows * tile + (rows + 1) * gap;
    const composites = [];

    for (let index = 0; index < imagePaths.length; index += 1) {
        const input = imagePaths[index];
        if (!fs.existsSync(input)) throw new Error(`参考图不存在：${index + 1}`);
        const buffer = await sharp(input)
            .rotate()
            .resize(tile - 8, tile - 8, { fit: 'contain', background: '#f4f5ef' })
            .flatten({ background: '#f4f5ef' })
            .extend({ top: 4, bottom: 4, left: 4, right: 4, background: '#171c18' })
            .png()
            .toBuffer();
        composites.push({
            input: buffer,
            left: gap + (index % columns) * (tile + gap),
            top: gap + Math.floor(index / columns) * (tile + gap)
        });
    }

    await sharp({ create: { width, height, channels: 3, background: '#f4f5ef' } })
        .composite(composites)
        .png()
        .toFile(outputPath);
    return outputPath;
}

module.exports = { createReferenceBoard };
