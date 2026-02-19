const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { JSDOM } = require('jsdom');

const app = express();
app.use(cors());

// URL del RSS de Pronóstico Mareológico (Suele ser más estable)
const SHN_URL = 'http://www.hidro.gob.ar/RSS/PMrss.asp';

app.get('/', (req, res) => {
    res.send('API Mareas Argentinas funcionando. Usa /api/mareas');
});

app.get('/api/mareas', async (req, res) => {
    try {
        // 1. Descargar XML crudo (ignorando SSL)
        const response = await axios.get(SHN_URL, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        const xmlText = new TextDecoder('latin1').decode(response.data);

        // 2. Extraer HTML dentro de CDATA
        const match = xmlText.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/s);
        if (!match) throw new Error("XML sin datos CDATA");
        
        const htmlContent = match[1];
        
        // 3. Parsear HTML con JSDOM
        const dom = new JSDOM(htmlContent);
        const doc = dom.window.document;
        const tables = doc.querySelectorAll('table');
        
        const cleanData = [];

        tables.forEach(table => {
            const rows = table.querySelectorAll('tr');
            rows.forEach(row => {
                const cells = row.querySelectorAll('td');
                // Estructura esperada: Lugar | Estado | Hora | Altura | Fecha
                // Buscamos filas con al menos 4 celdas
                if (cells.length >= 4) {
                    const lugar = cells[0].textContent.trim().toUpperCase();
                    const hora = cells[2].textContent.trim();
                    const alturaRaw = cells[3].textContent.trim().replace(',', '.');
                    const altura = parseFloat(alturaRaw);

                    if (!isNaN(altura)) {
                        cleanData.push({
                            estacion: lugar, // Ej: "SAN FERNANDO"
                            hora: hora,
                            altura: altura
                        });
                    }
                }
            });
        });

        res.json({ status: "ok", data: cleanData });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error conectando al SHN", details: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));