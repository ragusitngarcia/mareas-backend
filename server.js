const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { JSDOM } = require('jsdom');

const app = express();
app.use(cors());

// URL OFICIAL (Tabla Web)
const SHN_URL = 'https://www.hidro.gov.ar/oceanografia/alturashorarias.asp';

app.get('/api/mareas', async (req, res) => {
    console.log("--- Iniciando Scraper SHN ---");
    try {
        const response = await axios.get(SHN_URL, {
            responseType: 'arraybuffer',
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36' 
            }
        });

        // Decodificamos usando latin1 (iso-8859-1) que es lo que usa el SHN
        const htmlText = new TextDecoder('iso-8859-1').decode(response.data);
        const dom = new JSDOM(htmlText);
        const doc = dom.window.document;

        const data = [];
        
        // Buscamos TODAS las filas de TODAS las tablas
        const rows = Array.from(doc.querySelectorAll('tr'));
        console.log(`Filas encontradas: ${rows.length}`);

        // 1. Encontrar la cabecera con las horas
        // Buscamos una fila que tenga números con formato de hora (ej: 21:45)
        let timeHeaders = [];
        let headerRow = rows.find(r => {
            const text = r.textContent;
            // Busca al menos dos patrones horarios seguidos para confirmar que es la cabecera
            return /\d{2}:\d{2}.*\d{2}:\d{2}/.test(text);
        });

        if (headerRow) {
            console.log("Cabecera de horas encontrada.");
            // Usamos 'td, th' porque a veces cambian el formato
            const cells = Array.from(headerRow.querySelectorAll('td, th'));
            timeHeaders = cells.map(c => {
                const match = c.textContent.match(/(\d{2}:\d{2})/);
                return match ? match[1] : null;
            });
        } else {
            console.warn("ADVERTENCIA: No se encontró fila de cabecera de horas.");
        }

        // 2. Extraer datos de los puertos
        rows.forEach(row => {
            // Importante: Buscar tanto en TD como en TH
            const cells = Array.from(row.querySelectorAll('td, th'));
            
            if (cells.length > 1) {
                const rowText = cells[0].textContent.trim().toUpperCase(); // Primera celda es el nombre
                
                // Lista de puertos que nos interesan
                const targets = ['SAN FERNANDO', 'BUENOS AIRES', 'LA PLATA', 'MAR DEL PLATA', 'BELGRANO', 'OYARVIDE'];
                
                // Verificamos si esta fila es de uno de nuestros puertos
                const esPuerto = targets.some(t => rowText.includes(t));

                if (esPuerto) {
                    console.log(`Procesando fila: ${rowText}`);
                    
                    // Buscamos el primer valor numérico válido (ignorando la primera celda que es el nombre)
                    for (let i = 1; i < cells.length; i++) {
                        // Limpieza agresiva: sacar espacios, convertir comas
                        let valText = cells[i].textContent.trim().replace(',', '.');
                        let val = parseFloat(valText);

                        if (!isNaN(val)) {
                            // ¡Encontrado!
                            // Intentamos pegar la hora correcta de la cabecera, si no "Reciente"
                            let horaDato = (timeHeaders[i]) ? timeHeaders[i] : "Reciente";
                            
                            data.push({
                                estacion: rowText, // Nombre original de la fila
                                altura: val,
                                hora: horaDato
                            });
                            break; // Solo queremos el dato más reciente (el primero que aparece)
                        }
                    }
                }
            }
        });

        console.log(`Datos extraídos exitosamente: ${data.length}`);
        
        // Respuesta Final
        res.json({ 
            status: "ok", 
            source: "SHN Web Scraper",
            data: data 
        });

    } catch (error) {
        console.error("ERROR CRÍTICO:", error.message);
        res.status(500).json({ error: "Fallo Scraper", details: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listo en puerto ${PORT}`));
