import tl = require("azure-pipelines-task-lib/task");
import Q = require("q");
import util = require("util");
import querystring = require('querystring');
import * as fs from 'fs';
import * as SftpClient from 'ssh2-sftp-client';

var uuid = require('uuid/v4');
var httpClient = require('vso-node-api/HttpClient');
var httpObj = new httpClient.HttpCallbackClient(tl.getVariable("AZURE_HTTP_USER_AGENT"));

var os = require('os');
var Ssh2Client = require('ssh2').Client;
var shell = require('shelljs');

var _outStream = process.stdout;
export function _writeLine(str): void {
    _outStream.write(str + os.EOL);
}

export class RemoteCommandOptions {
    public failOnStdErr : boolean;
}

/**
    * Uses sftp to copy a file to remote machine
    * @param src
    * @param dest
    * @param sftpConfig
    * @returns {Promise<string>|Promise<T>}
    */
export async function copyFileToRemoteMachine(src: string, dest: string, sftpConfig: SftpClient.ConnectOptions): Promise<string> {
    var defer = Q.defer<string>();

    const sftpClient = new SftpClient();

    try {
        await sftpClient.connect(sftpConfig);        
        await sftpClient.put(src, dest);
        
        tl.debug('src and dest files at src ' + src + ' dest: ' +dest);
        const fileContent = await sftpClient.get(dest);
        
        // The content will be a buffer, so convert it to string
        const fileText = fileContent.toString('utf8');
        console.log('File content:', fileText);

        tl.debug('Copied script file to remote machine at: ${dest}');
        defer.resolve('0');
    } catch (err) {
        defer.reject(tl.loc('RemoteCopyFailed', err));
    }

    try {
        sftpClient.on('error', (err) => {
            tl.debug(`sftpClient: Ignoring error diconnecting: ${err}`);
        }); // ignore logout errors - since there could be spontaneous ECONNRESET errors after logout; see: https://github.com/mscdex/node-imap/issues/695
        await sftpClient.end();
    } catch(err) {
        tl.debug('Failed to close SFTP client: ${err}');
    }

    return defer.promise;
}

/**
 * Sets up an SSH client connection, when promise is fulfilled, returns the connection object
 * @param sshConfig
 * @returns {Promise<any>|Promise<T>}
 */
export function setupSshClientConnection(sshConfig: any): Q.Promise<any> {
    var defer = Q.defer<any>();
    var client = new Ssh2Client();
    client.on('ready', () => {
        defer.resolve(client);
    }).on('error', (err) => {
        defer.reject(err);
    }).connect(sshConfig);
    return defer.promise;
}

/**
 * Runs command on remote machine and returns success or failure
 * @param command
 * @param sshClient
 * @param options
 * @returns {Promise<string>|Promise<T>}
 */
export function runCommandOnRemoteMachine(command: string, sshClient: any, options: RemoteCommandOptions): Q.Promise<string> {
    var defer = Q.defer<string>();
    var stdErrWritten: boolean = false;

    if (!options) {
        tl.debug('Options not passed to runCommandOnRemoteMachine, setting defaults.');
        var options = new RemoteCommandOptions();
        options.failOnStdErr = true;
    }

    var cmdToRun = command;
    tl.debug('cmdToRun = ' + cmdToRun);

    sshClient.exec(cmdToRun, (err, stream) => {
        if (err) {
            tl.debug('code line 95 ' + err);
            defer.reject("test1")
            tl.debug('code line 97 ');
        } else {
            stream.on('close', (code, signal) => {
                tl.debug('code = ' + code + ', signal = ' + signal);

                //based on the options decide whether to fail the build or not if data was written to STDERR
                if (stdErrWritten === true && options.failOnStdErr === true) {
                    tl.debug('code line 104 ' + code);
                    defer.reject("test2");
                } else if (code && code != 0) {
                    defer.reject(tl.loc('RemoteCmdNonZeroExitCode', cmdToRun, code));
                } else {
                    //success case - code is undefined or code is 0
                    defer.resolve('0');
                }
            }).on('data', (data) => {
                _writeLine(data);
            }).stderr.on('data', (data) => {
                stdErrWritten = true;
                tl.debug('stderr = ' + data);
                if (data && data.toString().trim() !== '') {
                    tl.error(data);
                }
            });
        }
    });
    return defer.promise;
}

export function runCommandOnSameMachine(command: string, options: RemoteCommandOptions): Q.Promise<string> {
    var defer = Q.defer<string>();
    var stdErrWritten: boolean = false;

    if (!options) {
        tl.debug('Options not passed to runCommandOnRemoteMachine, setting defaults.');
        var options = new RemoteCommandOptions();
        options.failOnStdErr = true;
    }

    var cmdToRun = command;
    tl.debug('cmdToRun = ' + cmdToRun);

    shell.exec(cmdToRun, (err, stdout, stderr) => {
        if (err) {
            tl.debug('code = ' + err);
            defer.reject(tl.loc('RemoteCmdNonZeroExitCode', cmdToRun, err))
        } else {
            tl.debug('code line 144 err = ' + err + ' stderr = ' + stderr);
            tl.debug('code = 0');
            if (stderr != '' && options.failOnStdErr === true) {
                defer.reject("test");
            } else {
                defer.resolve('0');
            }
        }
    });
    return defer.promise;
}

export function testIfFileExist(filePath: string): boolean {
    return shell.test('-f', filePath)
}

export function testIfDirectoryExist(directoryPath: string): boolean {
    return shell.test('-d', directoryPath)
}

export function getAgentPlatform(): string {
    return os.platform();
}

export function getShellWhich(moduleName: string): string {
    return shell.which(moduleName);
}

export class WebRequest {
    public method: string;
    public uri: string;
    public body: any;
    public headers: any;
    constructor() {
        this.headers = {};
        this.body = querystring.stringify({});
        this.method = 'GET';
        this.uri = "";
    }
}

export class WebResponse {
    public statusCode: number;
    public headers: any;
    public body: any;
    public statusMessage: string;
}

export async function beginRequest(request: WebRequest): Promise<WebResponse> {
    request.headers = request.headers || {};
    request.body = request.body || querystring.stringify({});
    var httpResponse = await beginRequestInternal(request);
    return httpResponse;
}

function beginRequestInternal(request: WebRequest): Promise<WebResponse> {

    tl.debug(util.format("[%s]%s", request.method, request.uri));

    return new Promise<WebResponse>((resolve, reject) => {
        httpObj.send(request.method, request.uri, request.body, request.headers, (error, response, body) => {
            if (error) {
                reject(error);
            }
            else {
                var httpResponse = toWebResponse(response, body);
                resolve(httpResponse);
            }
        });
    });
}

export function getTemporaryInventoryFilePath(): string {
    return '/tmp/' + uuid() + 'inventory.ini';
}

function toWebResponse(response, body): WebResponse {
    var res = new WebResponse();

    if (response) {
        res.statusCode = response.statusCode;
        res.headers = response.headers;
        res.statusMessage = response.statusMessage;
        if (body) {
            try {
                res.body = JSON.parse(body);
            }
            catch (error) {
                res.body = body;
            }
        }
    }
    return res;
}