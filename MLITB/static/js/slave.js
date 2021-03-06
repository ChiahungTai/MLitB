/* 
    needs to be inherited by native worker instance
    
    functions to be inherited:
    - start_socket(boss_id) : connection with master
    - send_message_to_boss(type, data) : message to boss
    - send_message_to_master(type, data) : message to master 

    == JS LOGIC ONLY ==
    == DO NOT USE APIs NOT SUPPORTED BY NodeJS OR VICE VERSA ==

*/

var Slave = function() {
    this.id;
    this.boss_id;
    this.nn_id;

    this.host;

    this.data = {};

    this.Net; // the NN
    this.is_initialised;

    this.step = 0;

    this.is_train = true;

    this.labels = [];

    this.new_labels = [];

    this.is_track = false;
    this.is_stats = false;
    this.stats_running = false;
    this.point_list = {};
    this.prev_data = {};

}

Slave.prototype = {

    logger: function(text) {
        t = this.id + ' > ' + text;
        this.send_message_to_boss('logger', t);
    },

    status: function(text) {
        this.send_message_to_boss('status', text);
    },

    obj_to_list: function(files) {

        var list = [];

        var r = Object.keys(files);

        var i = r.length;
        while(i--) {
            list.push(files[r[i]]);
        }

        return list;

    },

    download_data: function(data) {
        // from boss to this slave
        this.data[data.id] = {
            data: data.data,
            label: data.label
        }

        // check if this label is new. Should not exist in known label list, and newly added label list.
        if(this.labels.indexOf(data.label) == -1 && this.new_labels.indexOf(data.label) == -1) {
            this.labels.push(data.label);
            this.new_labels.push(data.label);
        }

    },

    download: function() {

        var net = this.Net.getConfigsAndParams();

        this.send_message_to_boss('download_parameters', { 
            data: net
        });

    },

    new_parameters: function(d) {

        console.log(' $$ slave got new parameters');

        var data = JSON.parse(d);

        var parameters = data.parameters
        var new_labels = data.new_labels;
        var newL = new_labels.length;
        var oldL = Object.keys(this.Net.label2index).length;
        if (newL> oldL){
            //if there's any difference in label length, than add new
            //this should be enough, no need to do any further checking
            //since we can only addLabel and not remove label,
            //the order should be consistent from the neuralnetwork.js
            var addedLabel = new_labels.slice(oldL,newL);
            if(addedLabel.length) {
                console.log(this.id+' adding labels '+JSON.stringify(addedLabel));

                this.Net.addLabel(addedLabel);
            }

        } else if (newL<oldL){
            console.log(' Something is wrong, new labels size is smaller');
        }

        var step = data.step;

        if (step > 0) {
            this.Net.setParams(parameters);

        }

        // set step now. If worker was waiting, signal to go.
        this.step = data.step;

        console.log(' $$ parameters set.');

        if(this.is_track) {
            this.status('tracking: ' + step);
        }

        if(this.is_stats == true && this.stats_running == false) {
            return this.stats(step);
        }

        if(this.waiting_for_parameters == true) {

            this.waiting_for_parameters = false;

            console.log(' $$ release to work');

            this.work(this.wait_parameters);

        }
        
    },

    // add_new_labels: function(new_labels) {
    //     //console.log(this.id+' '+JSON.stringify(new_labels));
    //     if(new_labels.length) {

    //         var i = new_labels.length;
    //         while(i--) {
    //             var label = new_labels[i];
    //             // new label does not exist in new_labels or existing labels.
    //             if(this.labels.indexOf(label) == -1 && this.new_labels.indexOf(label) == -1) {
    //                 this.labels.push(label);
    //                 this.new_labels.push(label);
    //             }
    //         }

    //     }
    //     // console.log(this.id+' '+JSON.stringify(this.new_labels));
    //     if(this.new_labels.length) {

    //         this.Net.addLabel(this.new_labels);

    //     }
    //     //console.log(this.id + ': ' + JSON.stringify(this.Net.label2index));

    //     this.new_labels = [];

    // },

    classify: function(data) {

        var vol_input = this.Net.conf[0];

        var Input = new mlitb.Vol(vol_input.sx, vol_input.sy, vol_input.depth, 0.0);
        Input.data = data.data;
        this.Net.forward(Input);
        var results = this.Net.getPrediction().data;

        var labeledResults = [];

        var j = results.length;
        while(j--) {
            labeledResults.push([j, this.Net.index2label[j], results[j].toFixed(6)]);
        }

        labeledResults = labeledResults.sort(function(a,b) {
            return b[2] - a[2];
        });

        this.send_message_to_boss('classify_results', labeledResults);

    },

    stats: function(step) {

        var that = this;

        this.stats_running = true;

        var data = this.obj_to_list(this.data);

        var i = data.length;

        var error = 0.0;
        var nVector = 0;
        var vol_input = this.Net.conf[0];
        var pred;
        var max=0;

        while(i--) {

            point = data[i];

            Input = new this.mlitb.Vol(vol_input.sx, vol_input.sy, vol_input.depth, 0.0);
            Input.data = point.data;
            this.Net.forward(Input,true);
            // newerr = this.Net.backward(point.label);
            pred = this.Net.getPrediction().data;
            
            max = 0;
            for (var j = 1; j < pred.length; j++) {
                if (pred[j]>pred[max]){max = j}
            };
            
            if (point.label !== this.Net.index2label[max]){
                error += 1;    
            }
    
        }

        var error_pretty = (error / data.length) * 100.0;
        
        this.send_message_to_boss('stats_results', {
            step: step,
            error: error_pretty.toFixed(3)
        });
        
        // we need to clear the event queue.
        // i.e. to pass lagging updates.
        setTimeout(function() {
            that.stats_running = false;
        }, 100);

        
    },

    start_stats: function() {

        this.is_stats = true;

    },

    start_track: function() {

        this.is_track = true;

    },    

    job: function(d) {

        this.send_message_to_boss('worker_stats', {
            worker_power: d.power,
        });

        // start time immediately
        this.start_time = (new Date).getTime();

        var step = d.step;

        // IMPORTANT: it CANNOT work when the parameters are not downloaded yet by XHR!
        if(this.step < step) {
            this.waiting_for_parameters = true;
            this.wait_parameters = d;
            this.status('waiting for parameters');

            console.log(' $$ parameters NOT on time for work');

            return;
        }

        console.log(' $$ parameters on time for work');

        this.work(d);

    },

    work: function(d) {

        var that = this;


        var data = d.data;
        var idx;
        // if (that.step>100&& this.step%10==0)
        //     console.log(that.id+' point '+JSON.stringify(data));
        // var s = {};
        // var diff=0;
        // for (var dd=0;dd<data.length;dd++){
        //     idx = data[dd];
        //     s[idx]=1;
        //     // that.point_list[idx]=(that.point_list[idx]||0)+1;    
        //     if (!that.prev_data[idx]){
        //         diff +=1;
        //     }
        // }
        // console.log('point diff '+diff+' / '+data.length+' / '+Object.keys(that.data).length);
        // that.prev_data = s;
        
        // var new_labels = d.new_labels;
        // console.log('point d.new_labels '+JSON.stringify(new_labels));
        var iteration_time = d.iteration_time - 10; // subtract 10MS for spare time, to do reduction step.

        var time = (new Date).getTime();

        console.log(' $$ time loss due to parameter download delay:', time - this.start_time, 'MS');

        this.send_message_to_boss('workingset', d.data.length);
        that.status('working');
        
        var workingset = [];

        var vol_input = that.Net.conf[0];
        var error = 0.0;
        var nVector = 0;
        var proceeded_data = [];

        shuffle = function(o){
            for(var j, x, i = o.length; i; j = Math.floor(Math.random() * i), x = o[--i], o[i] = o[j], o[j] = x);
            return o;
        };

        shuffle_data = function() {
            
            console.log('shuffle');

            workingset = shuffle(data.slice());

        }


        initialise = function() {

            //console.log(that.id+' before add labels '+JSON.stringify(Object.keys(that.Net.label2index)));
            
            //no need to do this anymore
            // that.add_new_labels(new_labels);

            //console.log(that.id+' after add labels '+JSON.stringify(Object.keys(that.Net.label2index)));
        }

        learn = function() {

            while(true) {

                if(!workingset.length) {
                    shuffle_data();
                }

                point_id = workingset.pop()
                // that.point_list[ddd]=(that.point_list[point_id]||0)+1;
                point = that.data[point_id];

                Input = new that.mlitb.Vol(vol_input.sx, vol_input.sy, vol_input.depth, 0.0);
                Input.data = point.data;
                that.Net.forward(Input,true);
                newerr = that.Net.backward(point.label);

                error += newerr;
                
                nVector++;

                current_time = (new Date).getTime();

                if(current_time > (that.start_time + iteration_time)) {
                    var pp=Object.keys(that.point_list);
                    // console.log(that.id+' point list total '+JSON.stringify(pp)+' -- '+pp.length+'/'+data.length);
                    return;
                }

            }
            var pp=Object.keys(that.point_list);
            // console.log(that.id+' point list total '+JSON.stringify(pp)+' -- '+pp.length+'/'+data.length);

        }

        reduction = function() {
            
            // PROBLEM parameters never null
            // if (parameters == null){
            // let's use step=0, is that correct ?

            
            // if (step == 0){
            //     param = [that.Net.getParams(), that.Net.getGrads()];
            //     param_type = 'params_and_grads';
            // } else if (that.new_labels.length){
            //     //meaning that we just added some labels in the middle of trainig (not in step 0)
            //     //we need to tell param server and send the initial value for newly added params
            //     param = [that.Net.getParams(), that.Net.getGrads()];
            //     param_type = 'new_labels';
            // } else {
                param = that.Net.getGrads();
                param_type = 'grads';
            // }

            parameters = {
                parameters : param,
                parameters_type : param_type,
                error : error,
                nVector : nVector,
                proceeded_data : proceeded_data
            };

            console.log(that.id+' $ error: ' + error+' vector '+nVector);

            that.logger(nVector.toString() + ' points processed');

            that.send_message_to_master('reduction', {
                slave: that.id,
                nn_id: that.nn_id,
                parameters: parameters //,
                //new_labels: that.new_labels
            }); 

        }

        console.log('step '+ this.step);

        initialise();
        learn();
        reduction();

        this.status('waiting for master');

    },

    download_configuration: function() {
        console.log('slave/download_configuration')
        var that = this;

        var xhr = new XMLHttpRequest();
        xhr.open('GET', this.host + '/download-nn/' + this.nn_id, true);
        xhr.setRequestHeader("Content-Type", "application/json;charset=UTF-8");

        xhr.onload = function () {

            var response = JSON.parse(this.response);

            // apply configuration
            // i.e. layer conf, params, labels, etc. etc.
            // is only once.
            that.Net.setConfigsAndParams(response.net);
            console.log(JSON.stringify(response.net.configs));
            // console.log('just after set nn'+that.Net.layers[that.Net.layers.length-2].layer_type+' '+that.Net.layers[that.Net.layers.length-2].filters.data.length);


            // set initial this.labels
            that.labels = Object.keys(that.Net.index2label);
            console.log('labels after set '+JSON.stringify(that.labels));

            that.step = response.step;

            that.logger('Downloading NN configuration done.');
            that.status('waiting for task');

            //console.log(that.Net);

        }

        this.logger('Downloading NN configuration');
        this.status('downloading configuration');
        xhr.send();

        

    },

    disconnect: function() {

        this.logger('Worker terminated');
        this.status('terminated');

    },

    set_slave_id: function(id) {
        
        this.id = id;
        this.send_message_to_boss('slave_id', id);

        // start empty Net
        this.Net = new mlitb.Net();

        this.download_configuration();

    },

    start: function(data) {

        id = data.boss_id;
        this.nn_id = data.nn_id;
        this.host = data.host;

        this.boss_id = id;
        this.start_socket(id);

        this.send_message_to_master('new_slave', { 
            boss_id: this.boss_id ,
            nn: this.nn_id
        });

    },

    message_from_master: function(data) {

        if(data.type == 'slave_id') {
            this.set_slave_id(data.data);
        } else if(data.type == 'job') {
            this.job(data.data);
        } else if(data.type == 'ping') {
            this.send_message_to_master('pong');
        }

    },

    message_from_boss: function(e) {
        
        data = e.data;

        if(data.type == 'start') {
            this.start(data.data);
        } else if(data.type == 'download_data') {
            this.download_data(data.data);
        } else if(data.type == 'parameters') {
            this.new_parameters(data.data);
        } else if(data.type == 'remove') {
            this.remove();
        } else if(data.type == 'download') {
            this.download();
        } else if(data.type == 'classify') {
            this.classify(data);
        } else if(data.type == 'start_stats') {
            this.start_stats();
        } else if(data.type == 'start_track') {
            this.start_track();
        }
        
    }

}

if(typeof(module) !== 'undefined') {
    module.exports = Slave;
}