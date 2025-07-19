
const sharp = require('sharp');
const { createCanvas, loadImage, registerFont } = require('canvas');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

class RelatorioPremium {
    constructor(nome, idUser, time, urlSearch, quantidade) {
        this.largura = 1600;
        this.altura = 800;
        this.fundoEscuro = { r: 8, g: 18, b: 45 };
        this.corTexto = { r: 245, g: 245, b: 255 };
        this.corSecundaria = { r: 60, g: 95, b: 180 };
        this.corDestaque = { r: 80, g: 190, b: 240 };
        this.corIcones = { r: 120, g: 220, b: 255 };
        this.margem = 70;
        this.espacamento = 90;
        this.nome = nome;
        this.idUser = idUser;
        this.time = time;
        this.urlSearch = urlSearch;
        this.quantidade = quantidade;
        
        this.canvas = createCanvas(this.largura, this.altura);
        this.ctx = this.canvas.getContext('2d');
        
        this.carregarFontes();
        this.criarIcones();
    }

    gerarHash() {
        const texto = `${this.nome}${this.idUser}`;
        return crypto.createHash('md5').update(texto).digest('hex').substring(0, 8);
    }

    carregarFontes() {
        // Para simplificar, vamos usar fontes padrão do canvas
        this.fontes = {
            'titulo': '38px Arial',
            'subtitulo': '26px Arial',
            'destaque': '42px Arial',
            'normal': '32px Arial',
            'secundario': '24px Arial'
        };
    }

    criarIcones() {
        this.icones = {
            'user': this.criarIconeRedondo("👤", 60, this.corIcones),
            'id': this.criarIconeRedondo("🆔", 60, { r: 120, g: 220, b: 180 }),
            'time': this.criarIconeRedondo("🕒", 60, { r: 220, g: 180, b: 100 }),
            'hash': this.criarIconeRedondo("🔑", 60, { r: 200, g: 150, b: 240 }),
            'web': this.criarIconeRedondo("🌐", 60, { r: 100, g: 200, b: 240 }),
            'qtd': this.criarIconeRedondo("🔢", 60, { r: 150, g: 240, b: 150 })
        };
    }

    criarIconeRedondo(emoji, tamanho, cor) {
        // Para simplificar, vamos retornar um objeto com as propriedades do ícone
        return {
            emoji: emoji,
            tamanho: tamanho,
            cor: cor
        };
    }

    criarDegrade() {
        const gradient = this.ctx.createLinearGradient(0, 0, this.largura, 0);
        gradient.addColorStop(0, `rgb(${this.fundoEscuro.r}, ${this.fundoEscuro.g}, ${this.fundoEscuro.b})`);
        gradient.addColorStop(1, `rgb(${this.fundoEscuro.r + 30}, ${this.fundoEscuro.g + 40}, ${this.fundoEscuro.b + 50})`);
        
        this.ctx.fillStyle = gradient;
        this.ctx.fillRect(0, 0, this.largura, this.altura);
        
        // Adicionar grid sutil
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        this.ctx.lineWidth = 1;
        
        for (let i = 0; i < this.largura; i += 120) {
            this.ctx.beginPath();
            this.ctx.moveTo(i, 0);
            this.ctx.lineTo(i, this.altura);
            this.ctx.stroke();
        }
        
        for (let j = 0; j < this.altura; j += 120) {
            this.ctx.beginPath();
            this.ctx.moveTo(0, j);
            this.ctx.lineTo(this.largura, j);
            this.ctx.stroke();
        }
    }

    criarCard() {
        // Sombra
        this.ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
        this.ctx.shadowBlur = 15;
        this.ctx.shadowOffsetX = 10;
        this.ctx.shadowOffsetY = 10;
        
        // Card principal
        this.ctx.fillStyle = `rgba(${this.corSecundaria.r}, ${this.corSecundaria.g}, ${this.corSecundaria.b}, 0.8)`;
        this.ctx.strokeStyle = `rgba(${this.corDestaque.r}, ${this.corDestaque.g}, ${this.corDestaque.b}, 0.6)`;
        this.ctx.lineWidth = 3;
        
        const x = this.margem;
        const y = this.margem;
        const width = this.largura - 2 * this.margem;
        const height = this.altura - 2 * this.margem;
        const radius = 40;
        
        this.roundRect(x, y, width, height, radius);
        this.ctx.fill();
        this.ctx.stroke();
        
        // Resetar sombra
        this.ctx.shadowColor = 'transparent';
        this.ctx.shadowBlur = 0;
        this.ctx.shadowOffsetX = 0;
        this.ctx.shadowOffsetY = 0;
    }

    roundRect(x, y, width, height, radius) {
        this.ctx.beginPath();
        this.ctx.moveTo(x + radius, y);
        this.ctx.lineTo(x + width - radius, y);
        this.ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        this.ctx.lineTo(x + width, y + height - radius);
        this.ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        this.ctx.lineTo(x + radius, y + height);
        this.ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        this.ctx.lineTo(x, y + radius);
        this.ctx.quadraticCurveTo(x, y, x + radius, y);
        this.ctx.closePath();
    }

    desenharLogo() {
        const tamanho = 200;
        const x = this.largura - this.margem - tamanho / 2 - 20;
        const y = this.margem + tamanho / 2 + 20;
        
        // Círculo do logo
        this.ctx.strokeStyle = `rgba(${this.corDestaque.r}, ${this.corDestaque.g}, ${this.corDestaque.b}, 0.3)`;
        this.ctx.lineWidth = 5;
        this.ctx.beginPath();
        this.ctx.arc(x, y, tamanho / 2, 0, 2 * Math.PI);
        this.ctx.stroke();
        
        // Texto DARACK
        this.ctx.font = this.fontes['titulo'];
        this.ctx.fillStyle = `rgb(${this.corDestaque.r}, ${this.corDestaque.g}, ${this.corDestaque.b})`;
        this.ctx.textAlign = 'center';
        this.ctx.fillText("DARACK", x, y - 15);
        
        // Texto SERVER
        this.ctx.font = this.fontes['subtitulo'];
        this.ctx.fillStyle = `rgb(${this.corTexto.r}, ${this.corTexto.g}, ${this.corTexto.b})`;
        this.ctx.fillText("SERVER", x, y + 15);
    }

    desenharConteudo() {
        // Título
        const titulo = "CONFIRMACAO DE LOGIN";
        this.ctx.font = this.fontes['titulo'];
        this.ctx.fillStyle = `rgb(${this.corTexto.r}, ${this.corTexto.g}, ${this.corTexto.b})`;
        this.ctx.textAlign = 'center';
        this.ctx.fillText(titulo, this.largura / 2, this.margem + 60);
        
        const dados = [
            ["user", "NOME:", this.nome],
            ["id", "ID:", this.idUser.toString()],
            ["time", "DATA:", this.time],
            ["hash", "HASH:", this.gerarHash()],
            ["web", "URL:", this.urlSearch],
            ["qtd", "QTDS:", this.quantidade.toString()]
        ];

        let y = this.margem + 170;
        const alturaIcone = 60;
        const xIcone = this.margem + 40;
        const xTexto = xIcone + alturaIcone + 30;
        const xValor = xTexto + 300;
        
        dados.forEach(([chave, label, valor]) => {
            // Desenhar ícone
            const icon = this.icones[chave];
            this.ctx.font = '40px Arial';
            this.ctx.fillStyle = `rgb(${icon.cor.r}, ${icon.cor.g}, ${icon.cor.b})`;
            this.ctx.textAlign = 'center';
            this.ctx.fillText(icon.emoji, xIcone + 30, y + 15);
            
            // Desenhar label
            this.ctx.font = this.fontes['destaque'];
            this.ctx.fillStyle = `rgb(${this.corTexto.r}, ${this.corTexto.g}, ${this.corTexto.b})`;
            this.ctx.textAlign = 'left';
            this.ctx.fillText(label, xTexto, y + 15);
            
            // Desenhar valor
            let valorFormatado = valor;
            const larguraMaxValor = this.largura - xValor - 100;
            
            // Verificar se precisa truncar
            this.ctx.font = this.fontes['normal'];
            const medidaTexto = this.ctx.measureText(valorFormatado);
            if (medidaTexto.width > larguraMaxValor && valorFormatado.length > 10) {
                valorFormatado = valorFormatado.substring(0, valorFormatado.length - 4) + "...";
            }
            
            this.ctx.fillStyle = 'rgb(255, 255, 255)';
            this.ctx.fillText(valorFormatado, xValor, y + 15);
            
            y += this.espacamento;
        });
    }

    async gerarRelatorio() {
        this.criarDegrade();
        this.criarCard();
        this.desenharConteudo();
        this.desenharLogo();
        
        fs.ensureDirSync("results");
        const caminho = "results/relatorio_premium.png";
        
        const buffer = this.canvas.toBuffer('image/png');
        fs.writeFileSync(caminho, buffer);
        
        console.log(`Relatorio gerado em: ${caminho}`);
        return caminho;
    }
}

module.exports = RelatorioPremium;
