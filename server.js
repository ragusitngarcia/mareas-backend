const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { JSDOM } = require('jsdom');

const app = express();
app.use(cors());

const SHN_URL = 'https://www.hidro.gov.ar/oceanografia/alturashorarias.asp';

app.get('/api/mareas', async (req, res) => {
    console.log("--- SCRAPER V7: PREDICCIÓN MATEMÁTICA ---");
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

        const data = [];
        
        // Configuración de puertos
        const targets = [
            { id: 'San Fernando', name: 'SAN FERNANDO' },
            { id: 'Buenos Aires', name: 'BUENOS AIRES' },
            { id: 'La Plata', name: 'LA PLATA' },
            { id: 'Mar del Plata', name: 'MAR DEL PLATA' },
            { id: 'Puerto Belgrano', name: 'PUERTO BELGRANO' },
            { id: 'Oyarvide', name: 'OYARVIDE' }
        ];

        // Mapeo de Horas de la Cabecera
        const rows = Array.from(doc.querySelectorAll('tr'));
        let headerHours = [];
        const headerRow = rows.find(r => (r.textContent.match(/\d{2}:\d{2}/g) || []).length > 3);
        if(headerRow) {
             // Buscamos las celdas de la cabecera
             const cells = Array.from(headerRow.querySelectorAll('th, td'));
             cells.forEach(c => {
                 const m = c.textContent.match(/(\d{2}:\d{2})/);
                 if(m) headerHours.push(m[1]);
             });
        }

        // Búsqueda de Datos
        rows.forEach(row => {
            // Buscamos el enlace con el atributo especial
            const link = row.querySelector('a[data-nombre]');
            
            if (link) {
                const shnName = link.getAttribute('data-nombre');
                const target = targets.find(t => shnName.includes(t.id));

                if (target) {
                    const cells = Array.from(row.querySelectorAll('td'));
                    let currentVal = null;
                    let prevVal = null;
                    let horaDato = "Reciente";

                    // Buscamos el dato actual (Columna 1 de datos) y el anterior (Columna 2)
                    // Las celdas[0] es el nombre. celdas[1] es el dato más nuevo. celdas[2] el anterior.
                    
                    // Limpieza y parseo del valor actual
                    if(cells[1]) {
                        const raw = cells[1].textContent.trim().replace(',', '.');
                        if(!isNaN(parseFloat(raw))) {
                            currentVal = parseFloat(raw);
                            // Intentamos sacar la hora del array de cabeceras
                            // El índice de cells[1] corresponde a headerHours[0] generalmente
                            horaDato = headerHours[0] || "Reciente";
                        }
                    }

                    // Limpieza y parseo del valor anterior (para saber si sube o baja)
                    if(cells[2]) {
                        const raw = cells[2].textContent.trim().replace(',', '.');
                        if(!isNaN(parseFloat(raw))) prevVal = parseFloat(raw);
                    }

                    if (currentVal !== null) {
                        // GENERADOR DE CURVA ASTRONÓMICA
                        // Usamos el dato previo para calcular la tendencia (¿Está subiendo o bajando?)
                        let tendencia = 0; 
                        if (prevVal !== null) {
                            tendencia = currentVal - prevVal; // Positivo = Sube, Negativo = Baja
                        }

                        // Generamos 24 horas futuras
                        let curvaFutura = [];
                        let t = 0;
                        const amplitud = 0.8; // Amplitud promedio estimada (m)
                        
                        // Fase inicial aproximada basada en la tendencia
                        // Si está subiendo fuerte, estamos en la parte ascendente de la onda
                        let fase = tendencia > 0 ? 0 : Math.PI; 

                        for (let h = 0; h <= 24; h++) {
                            // Fórmula de Marea: ValorBase + Amplitud * Seno(frecuencia * tiempo + fase)
                            // El ciclo de marea es aprox 12 horas.
                            let val = currentVal + (Math.sin((h * Math.PI / 6) + fase) * 0.4) + (tendencia * 0.5 * Math.exp(-h/5));
                            
                            // Corrección suave para que empiece exactamente en el valor actual
                            if(h===0) val = currentVal;
                            
                            curvaFutura.push(parseFloat(val.toFixed(2)));
                        }

                        data.push({
                            estacion: target.name,
                            altura: currentVal,
                            hora: horaDato,
                            curva: curvaFutura
                        });
                        console.log(`✅ ${target.name}: ${currentVal}m (${horaDato})`);
                    }
                }
            }
        });

        res.json({ status: "ok", data: data });

    } catch (error) {
        console.error("ERROR:", error.message);
        // Respondemos con error JSON en vez de explotar
        res.status(500).json({ error: "Error interno del servidor", details: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server corriendo en ${PORT}`));
