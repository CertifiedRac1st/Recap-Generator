import fs from 'fs';

async function downloadFont() {
  console.log('Downloading font...');
  const res = await fetch('https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSansMyanmar/NotoSansMyanmar-Regular.ttf');
  const buffer = await res.arrayBuffer();
  fs.writeFileSync('NotoSansMyanmar-Regular.ttf', Buffer.from(buffer));
  console.log('Done');
}

downloadFont();
