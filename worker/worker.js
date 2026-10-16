const { createClient } = require('redis');

const cache = createClient({ url: process.env.REDIS_URL });

async function main() {
  await cache.connect();
  console.log('Worker de facturas en marcha');
  while (true) {
    const tarea = await cache.brPop('cola:facturas', 0);
    console.log('Generando la factura del pedido', tarea.element);
  }
}

main();
