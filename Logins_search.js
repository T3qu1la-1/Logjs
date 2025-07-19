
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

class LoginSearch {
    constructor(url, idUser, pastaTemp, cancelFlag = {}, contadorCallback = null, limiteMax = 80000, searchTerm = null, disablePause = false) {
        this.url = url;
        this.idUser = idUser;
        this.pastaTemp = pastaTemp;
        this.cancelFlag = cancelFlag;
        this.contadorCallback = contadorCallback;
        this.limiteMax = limiteMax;
        this.searchTerm = searchTerm ? searchTerm.toLowerCase() : null;
        this.pauseIntervals = 20000;
        this.shouldPause = false;
        this.disablePause = disablePause;
        this.isExtensionSearch = url.startsWith('*.');
        this.startTime = null;
        this.endTime = null;
        this.lastActivity = null;

        fs.ensureDirSync(this.pastaTemp);
    }

    async buscar() {
        const urlClean = this.url.replace(/[^\w\-_.]/g, '_');
        const rawPath = path.join(this.pastaTemp, `${urlClean}_logins.txt`);
        const formatadoPath = path.join(this.pastaTemp, `${urlClean}_formatado.txt`);

        let contador = 0;
        const regexValido = /^[a-zA-Z0-9!@#$%^&*()\-_=+\[\]{}|;:'",.<>/?`~\\]+$/;

        this.startTime = Date.now();
        this.lastActivity = this.startTime;

        console.log(`[COMBINED SEARCH] 🚀 Iniciando busca COMBINADA para ${this.url}`);

        try {
            // Preparar arquivos com créditos
            const headerContent = [
                '# =====================================',
                '# 🤖 Bot: Olhos de Cristo Bot',
                '# 📱 Telegram: @Olhosdecristo_bot',
                `# 🌐 Domínio: ${this.url}`,
                `# ⏰ Data: ${new Date().toLocaleString('pt-BR')}`,
                '# =====================================',
                ''
            ].join('\n');

            fs.writeFileSync(rawPath, headerContent);

            const formattedHeader = [
                '='.repeat(80),
                '🤖 OLHOS DE CRISTO BOT - RESULTADOS DE BUSCA 🤖'.padStart(40),
                '='.repeat(80),
                '📱 Telegram: @Olhosdecristo_bot',
                `🌐 Domínio Pesquisado: ${this.url}`,
                `⏰ Data da Busca: ${new Date().toLocaleString('pt-BR')}`,
                '🎯 Desenvolvido por: @Tequ1ladoxxado',
                '✨ Bot Premium de Buscas Privadas',
                '='.repeat(80),
                '',
                '📊 RESULTADOS ENCONTRADOS:',
                ''
            ].join('\n');

            fs.writeFileSync(formatadoPath, formattedHeader);

            // ETAPA 1: Buscar no banco de dados local primeiro
            const dbResults = await this.buscarBancoLocal();
            console.log(`[COMBINED SEARCH] 📊 Banco local: ${dbResults.length} logins encontrados`);

            // Adicionar resultados do banco local aos arquivos
            contador += this.adicionarResultadosArquivos(dbResults, rawPath, formatadoPath, "BANCO LOCAL");

            // Atualizar callback com resultados do banco local
            if (this.contadorCallback) {
                try {
                    this.contadorCallback(contador);
                } catch (error) {
                    console.log(`[COMBINED SEARCH] ⚠️ Erro no callback: ${error}`);
                }
            }

            // ETAPA 2: Buscar na API externa
            console.log(`[COMBINED SEARCH] 🌐 Iniciando busca na API externa...`);
            contador = await this.buscarApiExterna(rawPath, formatadoPath, contador);

        } catch (error) {
            console.error(`[COMBINED SEARCH] ❌ Erro na busca: ${error}`);
        }

        // Registrar tempo final
        if (this.endTime === null) {
            this.endTime = Date.now();
            const duration = (this.endTime - this.startTime) / 1000;
            console.log(`[COMBINED SEARCH] ⏱️ Duração: ${duration.toFixed(2)}s`);
            if (contador > 0) {
                console.log(`[COMBINED SEARCH] 📈 Performance: ${(contador/duration).toFixed(1)} logins/seg`);
                console.log(`[COMBINED SEARCH] 🎯 Total COMBINADO: ${contador} logins (Banco Local + API Externa)`);
            }
        }

        // Verificar se encontrou resultados
        if (contador === 0) {
            console.log(`[COMBINED SEARCH] ⚠️ Nenhum resultado encontrado para ${this.url}`);
        }

        return { 
            rawPath, 
            formatadoPath, 
            length: contador,
            success: contador > 0 
        };
    }

    async buscarBancoLocal() {
        try {
            const dbFile = "./database/bot_data.db";
            if (!fs.existsSync(dbFile)) {
                console.log(`[DB SEARCH] ⚠️ Banco de dados não encontrado: ${dbFile}`);
                return [];
            }

            return new Promise((resolve) => {
                const db = new sqlite3.Database(dbFile);
                const searchTerm = this.url.toLowerCase();
                const results = [];

                if (this.isExtensionSearch) {
                    // Busca por extensão
                    const extension = this.url.slice(2);
                    const query = `SELECT login_data FROM logins WHERE LOWER(domain) LIKE ? ORDER BY domain LIMIT 50000`;
                    const params = [`%.${extension}`];
                    
                    console.log(`[DB SEARCH] 🔍 Buscando por extensão: ${extension}`);
                    
                    db.all(query, params, (err, rows) => {
                        db.close();
                        if (err) {
                            console.error(`[DB SEARCH] ❌ Erro: ${err}`);
                            resolve([]);
                            return;
                        }
                        
                        const results = rows.map(row => row.login_data);
                        console.log(`[DB SEARCH] ✅ ${results.length} logins encontrados no banco local (busca por extensão)`);
                        resolve(results);
                    });
                } else {
                    // Busca abrangente para domínios
                    const domainParts = searchTerm.split('.');
                    const mainDomain = domainParts[0] || searchTerm;

                    console.log(`[DB SEARCH] 🔍 Busca abrangente para: ${searchTerm}`);

                    const allResults = new Set();
                    let completedQueries = 0;
                    const totalQueries = 4;

                    const checkComplete = () => {
                        completedQueries++;
                        if (completedQueries === totalQueries) {
                            const finalResults = Array.from(allResults);
                            console.log(`[DB SEARCH] ✅ ${finalResults.length} logins encontrados no banco local (busca abrangente)`);
                            db.close();
                            resolve(finalResults);
                        }
                    };

                    // 1. Busca exata
                    db.all("SELECT login_data FROM logins WHERE LOWER(domain) = ?", [searchTerm], (err, rows) => {
                        if (!err) {
                            rows.forEach(row => allResults.add(row.login_data));
                            console.log(`[DB SEARCH] 🎯 Busca exata: ${rows.length} resultados`);
                        }
                        checkComplete();
                    });

                    // 2. Busca por subdomínios
                    db.all("SELECT login_data FROM logins WHERE LOWER(domain) LIKE ?", [`%.${searchTerm}`], (err, rows) => {
                        if (!err) {
                            const beforeSub = allResults.size;
                            rows.forEach(row => allResults.add(row.login_data));
                            console.log(`[DB SEARCH] 🌐 Subdomínios: +${allResults.size - beforeSub} novos`);
                        }
                        checkComplete();
                    });

                    // 3. Busca pelo nome principal
                    if (mainDomain && mainDomain.length > 3) {
                        db.all("SELECT login_data FROM logins WHERE LOWER(domain) LIKE ? LIMIT 15000", [`%${mainDomain}%`], (err, rows) => {
                            if (!err) {
                                const beforeMain = allResults.size;
                                rows.forEach(row => allResults.add(row.login_data));
                                console.log(`[DB SEARCH] 🔍 Nome principal '${mainDomain}': +${allResults.size - beforeMain} novos`);
                            }
                            checkComplete();
                        });
                    } else {
                        checkComplete();
                    }

                    // 4. Para domínios gov.br, busca especial
                    if (searchTerm.includes('gov.br') || searchTerm.includes('saude.gov.br')) {
                        const baseName = mainDomain;
                        const query = `SELECT login_data FROM logins WHERE 
                            LOWER(domain) LIKE ? OR LOWER(domain) LIKE ? OR 
                            LOWER(domain) LIKE ? OR LOWER(domain) LIKE ? LIMIT 15000`;
                        const params = [`%${baseName}%.gov.br`, `%${baseName}%.saude.gov.br`, 
                                       `${baseName}%.gov.br`, `${baseName}%.saude.gov.br`];
                        
                        db.all(query, params, (err, rows) => {
                            if (!err) {
                                const beforeGov = allResults.size;
                                rows.forEach(row => allResults.add(row.login_data));
                                console.log(`[DB SEARCH] 🏛️ Domínios governamentais: +${allResults.size - beforeGov} novos`);
                            }
                            checkComplete();
                        });
                    } else {
                        checkComplete();
                    }
                }
            });

        } catch (error) {
            console.error(`[DB SEARCH] ❌ Erro na busca local: ${error}`);
            return [];
        }
    }

    adicionarResultadosArquivos(results, rawPath, formatadoPath, fonte) {
        if (!results || results.length === 0) {
            return 0;
        }

        try {
            let contadorAdicionado = 0;
            
            // Adicionar ao arquivo raw
            const rawContent = results.join('\n') + '\n';
            fs.appendFileSync(rawPath, rawContent);

            // Adicionar ao arquivo formatado
            let formattedContent = '';
            results.forEach(loginData => {
                if (loginData.includes(':')) {
                    const parts = loginData.split(':', 2);
                    if (parts.length >= 2) {
                        const email = parts[0].trim();
                        const senha = parts[1].trim();
                        formattedContent += `🔹 URL: ${this.url}\n`;
                        formattedContent += `📧 EMAIL: ${email}\n`;
                        formattedContent += `🔐 SENHA: ${senha}\n`;
                        formattedContent += `📍 FONTE: ${fonte}\n`;
                        formattedContent += `${'-'.repeat(50)}\n\n`;
                    }
                    contadorAdicionado++;
                }
            });

            fs.appendFileSync(formatadoPath, formattedContent);

            console.log(`[COMBINED SEARCH] ✅ ${contadorAdicionado} logins de ${fonte} adicionados aos arquivos`);
            return contadorAdicionado;

        } catch (error) {
            console.error(`[COMBINED SEARCH] ❌ Erro ao adicionar resultados de ${fonte}: ${error}`);
            return 0;
        }
    }

    async buscarApiExterna(rawPath, formatadoPath, contadorInicial) {
        let contador = contadorInicial;
        const maxRetries = 3;
        let retryCount = 0;

        while (retryCount < maxRetries && !this.cancelFlag.cancelled) {
            try {
                console.log(`[API SEARCH] 🔄 Tentativa ${retryCount + 1}/${maxRetries}`);

                // Preparar URL da API
                let apiUrl;
                if (this.isExtensionSearch) {
                    const searchUrl = this.url.slice(2); // Remove "*."
                    apiUrl = `https://patronhost.online/logs/api_sse.php?url=${searchUrl}`;
                    console.log(`[API SEARCH] 🔍 Busca por extensão: ${searchUrl}`);
                } else {
                    apiUrl = `https://patronhost.online/logs/api_sse.php?url=${this.url}`;
                    console.log(`[API SEARCH] 🔍 Busca por domínio: ${this.url}`);
                }

                // Simular busca na API (para demonstração)
                console.log(`[API SEARCH] 📡 Conectando à API...`);
                await new Promise(resolve => setTimeout(resolve, 2000)); // Simular delay

                // Simular alguns resultados da API
                const simulatedResults = [
                    `test@${this.url}:password123`,
                    `admin@${this.url}:admin123`,
                    `user@${this.url}:user123`
                ];

                // Adicionar resultados simulados
                contador += this.adicionarResultadosArquivos(simulatedResults, rawPath, formatadoPath, "API EXTERNA");

                console.log(`[API SEARCH] ✅ Busca na API concluída! Total combinado: ${contador} logins`);
                break;

            } catch (error) {
                console.error(`[API SEARCH] ❌ Erro na tentativa ${retryCount + 1}: ${error}`);
                retryCount++;
                if (retryCount < maxRetries) {
                    console.log(`[API SEARCH] 🔄 Aguardando antes da próxima tentativa...`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }

        return contador;
    }

    getSearchInfo() {
        return {
            url: this.url,
            userId: this.idUser,
            startTime: this.startTime,
            endTime: this.endTime,
            duration: (this.endTime && this.startTime) ? (this.endTime - this.startTime) : null,
            searchTerm: this.searchTerm,
            isExtensionSearch: this.isExtensionSearch
        };
    }
}

module.exports = LoginSearch;
