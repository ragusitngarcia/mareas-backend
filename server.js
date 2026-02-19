const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { JSDOM } = require('jsdom');

const app = express();
app.use(cors());

// AHORA APUNTAMOS A LA TABLA WEB (DATA FRESCA), NO AL RSS
const SHN_URL = 'https://www.hidro.gov.ar/oceanografia/alturashorarias.asp';

app.get('/api/mareas', async (req, res) => {
    try {
        // 1. Descargar el HTML de la web oficial
        const response = await axios.get(SHN_URL, {
            responseType: 'arraybuffer',
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' 
            }
        });
        
        const htmlText = new TextDecoder('iso-8859-1').decode(response.data); // Decodificar tildes correctamente
        const dom = new JSDOM(htmlText);
        const doc = dom.window.document;

        // 2. Analizar la Tabla
        // Buscamos la tabla que tiene los datos. Generalmente es la única grande.
        const rows = Array.from(doc.querySelectorAll('tr'));
        const data = [];

        // Primero buscamos la fila de cabecera para tener las HORAS
        let headerRow = rows.find(r => r.textContent.includes('Mareógrafo') && r.textContent.includes(':'));
        let timeHeaders = [];
        
        if (headerRow) {
            // Extraer las horas de las columnas (ej: "21:45", "20:45")
            // Limpiamos el texto para sacar fechas y dejar solo la hora HH:MM
            const cells = Array.from(headerRow.querySelectorAll('th, td'));
            timeHeaders = cells.map(c => {
                const txt = c.textContent.trim();
                const match = txt.match(/(\d{2}:\d{2})/);
                return match ? match[1] : null;
            });
        }

        // 3. Buscar las filas de cada puerto
        rows.forEach(row => {
            const cells = Array.from(row.querySelectorAll('td'));
            if (cells.length > 0) {
                const name = cells[0].textContent.trim().toUpperCase();
                
                // Filtramos solo los puertos que nos interesan
                if (['SAN FERNANDO', 'BUENOS AIRES', 'LA PLATA', 'MAR DEL PLATA', 'PUERTO BELGRANO', 'OYARVIDE'].some(k => name.includes(k))) {
                    
                    // Buscamos el primer valor numérico válido (de izquierda a derecha, que es lo más reciente)
                    let foundVal = null;
                    let foundTime = "Reciente";

                    for (let i = 1; i < cells.length; i++) {
                        const valText = cells[i].textContent.trim().replace(',', '.');
                        const val = parseFloat(valText);
                        
                        if (!isNaN(val)) {
                            foundVal = val;
                            // Intentamos recuperar la hora del header correspondiente a esta columna
                            if (timeHeaders[i]) {
                                foundTime = timeHeaders[i];
                            }
                            break; // Ya tenemos el dato más reciente, paramos.
                        }
                    }

                    if (foundVal !== null) {
                        data.push({
                            estacion: name,
                            altura: foundVal,
                            hora: foundTime // Aquí enviamos la hora real (ej: "21:45")
                        });
                    }
                }
            }
        });

        console.log("Datos scropeados:", data);
        res.json({ status: "ok", data: data });

    } catch (error) {
        console.error("Error:", error.message);
        res.status(500).json({ error: "Error leyendo SHN Web", details: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server corriendo en ${PORT}`));
