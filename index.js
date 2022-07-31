require('dotenv').config();
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const argv = yargs(hideBin(process.argv)).option('contract', {string: true}).argv;
const ethers = require('ethers');
const fs = require('fs');

/**
 * Required arguments
 **/
if (!argv.addressFile) {
  throw `Missing addressFile argument: node index.js --addressFile addresses.txt`;
}

const ADDRESS_PAIRS = fs.readFileSync(argv.addressFile, 'utf8').split('\n').map(row => row.split('\t')).map(list => list.map(item => item.trim()));

/**
Usage:
  node index.js --addressFile addresses.txt

Example:
  node index.js --addressFile demo.txt
**/

// Keep track of all of the ABIs to use for analysis
const erc1155ABI = JSON.parse(fs.readFileSync(__dirname + '/config/abi/erc1155.json', 'utf8'));
const erc20ABI = JSON.parse(fs.readFileSync(__dirname + '/config/abi/erc20.json', 'utf8'));
const erc721ABI = JSON.parse(fs.readFileSync(__dirname + '/config/abi/erc721.json', 'utf8'));

const erc1155Interface = new ethers.utils.Interface(erc1155ABI);
const erc20Interface = new ethers.utils.Interface(erc20ABI);
const erc721Interface = new ethers.utils.Interface(erc721ABI);


async function main() {

  // Get the etherscan provider
  let provider = new ethers.providers.EtherscanProvider("homestead", process.env.ETHERSCAN_KEY);

  let iterCount = 0;
  let passPairs = [], partialPairs = [], failPairs = [];
  for (let pair of ADDRESS_PAIRS) {
    let analysis = {
      'send-to' : 0,
      'sent-from' : 0
    };

    let history;

    try {
      history = await provider.getHistory(pair[0]);
      for (let tx of history) {
        let result = analyzeTransaction(tx, pair[0], pair[1]);
        if (result) {
          analysis[result]++;
        }
      }
    } catch (ex) {}

    // Now also analyze the other address
    try {
      history = await provider.getHistory(pair[1]);
      for (let tx of history) {
        let result = analyzeTransaction(tx, pair[1], pair[0]);
        if (result) {
          // Because we're going the other way around, we need to reverse the send-to / sent-from flags
          result = result === 'send-to' ? 'send-from' : 'send-to';
          analysis[result]++;
        }
      }
    } catch (ex) {}

    // If it passes, put in pass bucket. Halfway, partial. Totally, fail bucket.
    if (analysis['send-to'] > 0 && analysis['sent-from'] > 0) {
      passPairs.push(pair);
    } else if (analysis['send-to'] > 0 || analysis['sent-from'] > 0) {
      partialPairs.push(pair);
    } else {
      failPairs.push(pair);
    }

    console.log("On pair", ++iterCount, "of", ADDRESS_PAIRS.length, " - ", passPairs.length, "passing - ", partialPairs.length, "partial - ", failPairs.length, "failing");
  }

  fs.writeFileSync(__dirname + '/output/' + argv.addressFile + '-pass.txt', passPairs.map(line => line.join('\t')).join('\n'));
  fs.writeFileSync(__dirname + '/output/' + argv.addressFile + '-partial.txt', partialPairs.map(line => line.join('\t')).join('\n'));
  fs.writeFileSync(__dirname + '/output/' + argv.addressFile + '-fail.txt', failPairs.map(line => line.join('\t')).join('\n'));
  console.log("done");
}

function analyzeTransaction(tx, thisAddress, otherAddress) {
  // Sanity check
  if (!thisAddress || !otherAddress || !tx.from || !tx.to) {
    return false;
  }

  // Is this an ether transaction between two wallets?
  let result = checkAddresses(thisAddress, otherAddress, tx.from, tx.to);
  if (result) return result;

  // what about a token transaction from an intermediate contract?
  try {
    let decodedData = erc1155Interface.parseTransaction({ data: tx.data, value: tx.value });
    if (decodedData.name === 'safeTransferFrom' || decodedData.name === 'safeBatchTransferFrom') {
      let result = checkAddresses(thisAddress, otherAddress, decodedData.args._from, decodedData.args._to, '1155');
      if (result) return result;
    }
  } catch (ex) {}

  try {
    let decodedData = erc20Interface.parseTransaction({ data: tx.data, value: tx.value });
    if (decodedData.name === 'transfer' || decodedData.name === 'transferFrom') {
      let result = checkAddresses(thisAddress, otherAddress, decodedData.args.sender || thisAddress, decodedData.args.recipient, '20');
      if (result) return result;
    }
  } catch (ex) {}

  try {
    let decodedData = erc721Interface.parseTransaction({ data: tx.data, value: tx.value });
    if (decodedData.name === 'transferFrom' || decodedData.name === 'safeTransferFrom') {
      let result = checkAddresses(thisAddress, otherAddress, decodedData.args.from, decodedData.args.to, '721');
      if (result) return result;
    }
  } catch (ex) {}


  // default, nada
  return false;
}

function checkAddresses(thisAddress, otherAddress, from, to, type = 'ETH') {
  if (
    thisAddress.toLowerCase()  === from.toLowerCase() &&
    otherAddress.toLowerCase() === to.toLowerCase()
  ) {
    return 'send-to';
  } else if (
    otherAddress.toLowerCase()  === from.toLowerCase() &&
    thisAddress.toLowerCase() === to.toLowerCase()
  ) {
    return 'sent-from';
  }

  return false;
}


main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
