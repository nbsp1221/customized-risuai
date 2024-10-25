import { getDatabase, setDatabase } from 'src/ts/storage/database.svelte';
import { selectedCharID } from 'src/ts/stores';
import { get } from 'svelte/store';
import { doingChat, sendChat } from '../index.svelte';
import { downloadFile, isTauri } from 'src/ts/storage/globalApi';
import { HypaProcesser } from '../memory/hypamemory';
import { BufferToText as BufferToText, selectSingleFile, sleep } from 'src/ts/util';
import { postInlayImage } from './image';

type sendFileArg = {
    file:string
    query:string
}

async function sendPofile(arg:sendFileArg){

    let result = ''
    let msgId = ''
    let note = ''
    let speaker = ''
    let parseMode = 0
    const db = getDatabase()
    let currentChar = db.characters[get(selectedCharID)]
    let currentChat = currentChar.chats[currentChar.chatPage]
    const lines = arg.file.split('\n')
    for(let i=0;i<lines.length;i++){
        console.log(i)
        const line = lines[i]
        if(line === ''){
            if(msgId === ''){
                result += '\n'
                continue
            }
            let text = msgId
            if(speaker !== ''){
                text = `Speaker: ${speaker}\n${text}`
            }
            if(note !== ''){
                text = `Note: ${note}\n${text}`
            }
            currentChat.message.push({
                role: 'user',
                data: text
            })
            currentChar.chats[currentChar.chatPage] = currentChat
            db.characters[get(selectedCharID)] = currentChar
            setDatabase(db)
            doingChat.set(false)
            await sendChat(-1);
            currentChar = db.characters[get(selectedCharID)]
            currentChat = currentChar.chats[currentChar.chatPage]
            const res = currentChat.message[currentChat.message.length-1]
            const msgStr = res.data.split('\n').filter((a) => {
                return a !== ''
            }).map((str) => {
                return `"${str.replaceAll('"', '\\"')}"`
            }).join('\n')
            result += `msgstr ""\n${msgStr}\n\n`
            note = ''
            speaker = ''
            msgId = ''
            if(isTauri){
                await downloadFile('translated.po', result)
            }
            continue
        }
        if(line.startsWith('#. Note =')){
            note = line.replace('#. Notes =', '').trim()
            continue
        }
        if(line.startsWith('#. Speaker =')){
            speaker = line.replace('#. Speaker =', '').trim()
            continue
        }
        if(line.startsWith('msgid')){
            parseMode = 0
            msgId = line.replace('msgid ', '').trim().replaceAll('\\"', '♠#').replaceAll('"', '').replaceAll('♠#', '\\"')
            if(msgId === ''){
                parseMode = 1
            }
            result += line + '\n'
            continue
        }
        if(parseMode === 1 && line.startsWith('"') && line.endsWith('"')){
            msgId += line.substring(1, line.length-1).replaceAll('\\"', '"')
            result += line + '\n'
            continue
        }
        if(line.startsWith('msgstr')){
            if(msgId === ''){
                result += line + '\n'
                parseMode = 0
            }
            else{
                parseMode = 2
            }
            continue
        }
        if(parseMode === 2 && line.startsWith('"') && line.endsWith('"')){
            continue
        }
        result += line + '\n'

        if(i > 100){
            break //prevent too long message in testing
        }

    }
    await downloadFile('translated.po', result)
}

async function sendPDFFile(arg:sendFileArg) {
    const pdfjsLib = (await import('pdfjs-dist'));
    const pdfjsWorker = await import('pdfjs-dist/build/pdf.worker?worker&url');
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker.default;
    const pdf = await pdfjsLib.getDocument({data: arg.file}).promise;
    const texts:string[] = []
    for(let i = 1; i<=pdf.numPages; i++){
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const items = content.items as {str:string}[];
        for(const item of items){
            texts.push(item.str)
        }
    }
    console.log(texts)
    const hypa = new HypaProcesser('MiniLM')
    hypa.addText(texts)
    const result = await hypa.similaritySearch(arg.query)
    let message = ''
    for(let i = 0; i<result.length; i++){
        message += "\n" + result[i]
        if(i>5){
            break
        }
    }
    console.log(message)
    return Buffer.from(`<File>\n${message}\n</File>\n`).toString('base64')
}

async function sendTxtFile(arg:sendFileArg) {
    const lines = arg.file.split('\n').filter((a) => {
        return a !== ''
    })
    const hypa = new HypaProcesser('MiniLM')
    hypa.addText(lines)
    const result = await hypa.similaritySearch(arg.query)
    let message = ''
    for(let i = 0; i<result.length; i++){
        message += "\n" + result[i]
        if(i>5){
            break
        }
    }
    console.log(message)
    return Buffer.from(`<File>\n${message}\n</File>\n`).toString('base64')
}

async function sendXMLFile(arg:sendFileArg) {
    const hypa = new HypaProcesser('MiniLM')
    let nodeTexts:string[] = []
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(arg.file, "text/xml");
    const nodes = xmlDoc.getElementsByTagName('*')
    for(const node of nodes){
        nodeTexts.push(node.textContent)
    }
    hypa.addText(nodeTexts)
    const result = await hypa.similaritySearch(arg.query)
    let message = ''
    for(let i = 0; i<result.length; i++){
        message += "\n" + result[i]
        if(i>5){
            break
        }
    }
    console.log(message)
    return Buffer.from(`<File>\n${message}\n</File>\n`).toString('base64')    
}

type postFileResult = postFileResultImage | postFileResultVoid | postFileResultText

type postFileResultImage = {
    data: string,
    type: 'image',
}

type postFileResultVoid = {
    type: 'void',
}

type postFileResultText = {
    data: string,
    type: 'text',
    name: string
}
export async function postChatFile(query:string):Promise<postFileResult>{
    const file = await selectSingleFile([
        //image format
        'jpg',
        'jpeg',
        'png',
        'webp',
        'po',
        // 'pdf',
        'txt'
    ])

    if(!file){
        return null
    }

    const extention = file.name.split('.').at(-1)
    console.log(extention)

    switch(extention){
        case 'po':{
            await sendPofile({
                file: BufferToText(file.data),
                query: query
            })
            return {
                type: 'void'
            }
        }
        case 'pdf':{
            return {
                type: 'text',
                data: await sendPDFFile({
                    file: BufferToText(file.data),
                    query: query
                }),
                name: file.name
            }
        }
        case 'xml':{
            return {
                type: 'text',
                data: await sendXMLFile({
                    file: BufferToText(file.data),
                    query: query
                }),
                name: file.name
            }
        }
        case 'jpg':
        case 'jpeg':
        case 'png':
        case 'webp':{
            const postData = await postInlayImage(file)
            return {
                data: postData,
                type: 'image'
            }
        }
        case 'txt':{
            return {
                type: 'text',
                data: await sendTxtFile({
                    file: BufferToText(file.data),
                    query: query
                }),
                name: file.name
            }
        }
    }

    return 
}