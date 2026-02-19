const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { JSDOM } = require('jsdom');

const app = express();
app.use(cors());

const SHN_URL = 'https://www.hidro.gov.ar/oceanografia/alturashorarias.asp';

app.get('/api/mareas', async (req, res) => {
    console.log("--- SCRAPER V5: ALINEACIÓN POR COLUMNA ---");
    try {
        const response = await axios.get(SHN_URL, {
            responseType: 'arraybuffer',
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36' 
            }
        });

        const htmlText = new TextDecoder('iso-8859-1').decode(response.data);
        const dom = new JSDOM(htmlText);
        const doc = dom.window.document;

        const rows = Array.from(doc.querySelectorAll('tr'));
        console.log(`Filas analizadas: ${rows.length}`);

        // 1. MAPEAR LAS HORAS POR NÚMERO DE COLUMNA
        // Creamos un "Mapa" donde: Columna 1 = "21:45", Columna 2 = "20:45", etc.
        let timeMap = {};
        
        const headerRow = rows.find(r => {
            // Buscamos la fila que tenga muchas horas (XX:XX)
            return (r.textContent.match(/\d{2}:\d{2}/g) || []).length > 3;
        });

        if (headerRow) {
            const headerCells = Array.from(headerRow.querySelectorAll('td, th'));
            headerCells.forEach((cell, index) => {
                // Buscamos una hora XX:XX dentro de cada celda individualmente
                const match = cell.textContent.match(/(\d{2}:\d{2})/);
                if (match) {
                    timeMap[index] = match[1]; // Guardamos: "En la columna [index] la hora es [hora]"
                }
            });
            console.log("Mapa de columnas detectado (Indices):", Object.keys(timeMap));
        } else {
            console.log("⚠️ No se encontró cabecera de horas.");
        }

        // 2. BUSCAR DATOS Y ALINEAR
        const data = [];
        const targets = [
            { id: 'San Fernando', name: 'SAN FERNANDO' },
            { id: 'Buenos Aires', name: 'BUENOS AIRES' },
            { id: 'La Plata', name: 'LA PLATA' },
            { id: 'Mar del Plata', name: 'MAR DEL PLATA' },
            { id: 'Puerto Belgrano', name: 'PUERTO BELGRANO' },
            { id: 'Oyarvide', name: 'OYARVIDE' }
        ];

        rows.forEach(row => {
            const link = row.querySelector('a[data-nombre]');
            
            if (link) {
                const shnName = link.getAttribute('data-nombre');
                const target = targets.find(t => shnName.includes(t.id) || t.id.includes(shnName));

                if (target) {
                    const cells = Array.from(row.querySelectorAll('td'));
                    
                    // Recorremos las celdas de datos
                    for (let i = 0; i < cells.length; i++) {
                        const rawText = cells[i].textContent.trim();
                        
                        if (!rawText || rawText === '-' || rawText === '') continue;

                        const val = parseFloat(rawText.replace(',', '.'));

                        if (!isNaN(val) && val < 20) { 
                            // LA CLAVE: Usamos el índice 'i' de esta celda para pedirle la hora al mapa
                            // Si el dato está en la columna 1, el mapa nos devolverá la hora de la columna 1.
                            const horaExacta = timeMap[i] || "Reciente";

                            data.push({
                                estacion: target.name,
                                altura: val,
                                hora: horaExacta
                            });
                            console.log(`✅ ${target.name}: ${val}m -> Columna ${i} -> Hora ${horaExacta}`);
                            break; // Tomamos el primer dato (el más reciente) y salimos
                        }
                    }
                }
            }
        });

        res.json({ status: "ok", data: data });

    } catch (error) {
        console.error("ERROR:", error.message);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server corriendo en ${PORT}`));
